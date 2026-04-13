import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  executeComputerActions,
  normalizeDragPath,
  normalizeKeyName,
  scrollStepsFromDelta,
} from "./action-executor.js";
import { FakeDesktop } from "../test/test-helpers.js";

describe("action-executor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes key aliases and drag paths", () => {
    expect(normalizeKeyName(" CTRL ")).toBe("ctrl");
    expect(normalizeKeyName("ArrowDown")).toBe("down");
    expect(normalizeKeyName("Meta")).toBe("meta");
    expect(normalizeDragPath([{ x: 1, y: 2 }, [3, 4]])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(() => normalizeDragPath([[1, 2, 3] as unknown as [number, number]])).toThrow(
      "Drag path tuple entries must contain exactly two values",
    );
  });

  it("translates clicks, drags, scrolls, and keypresses to desktop commands", async () => {
    const desktop = new FakeDesktop();

    await executeComputerActions(desktop, [
      {
        type: "click",
        x: 12,
        y: 34,
        button: "right",
        keys: ["CTRL", "SHIFT"],
      },
      {
        type: "drag",
        path: [
          [10, 20],
          [30, 40],
          { x: 50, y: 60 },
        ],
      },
      {
        type: "scroll",
        x: 90,
        y: 120,
        scrollY: -240,
      },
      {
        type: "keypress",
        keys: ["META", "ArrowUp"],
      },
      {
        type: "type",
        text: "hello",
      },
    ]);

    expect(desktop.keyDown.mock.calls).toEqual([["ctrl"], ["shift"]]);
    expect(desktop.click).toHaveBeenCalledWith({
      button: "right",
      x: 12,
      y: 34,
    });
    expect(desktop.keyUp.mock.calls).toEqual([["shift"], ["ctrl"]]);

    expect(desktop.mousePress).toHaveBeenCalledWith({ x: 10, y: 20 });
    expect(desktop.moveMouse.mock.calls).toEqual([
      [30, 40],
      [50, 60],
      [90, 120],
    ]);
    expect(desktop.mouseRelease).toHaveBeenCalledWith();
    expect(desktop.scrollUp).toHaveBeenCalledWith(2, 90, 120);
    expect(desktop.press).toHaveBeenCalledWith(["meta", "up"]);
    expect(desktop.typeText).toHaveBeenCalledWith("hello");
  });

  it("waits without sending extra desktop input and rejects incomplete drags", async () => {
    vi.useFakeTimers();
    const desktop = new FakeDesktop();

    const waitPromise = executeComputerActions(desktop, [
      { type: "wait" },
      { type: "screenshot" },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    await waitPromise;

    expect(scrollStepsFromDelta(0)).toBe(0);
    expect(scrollStepsFromDelta(99)).toBe(1);
    expect(scrollStepsFromDelta(320)).toBe(3);
    expect(desktop.click).not.toHaveBeenCalled();
    expect(() =>
      executeComputerActions(desktop, [{ type: "drag", path: [[1, 2]] }]),
    ).rejects.toThrow("Drag action requires at least two path points");
  });
});
