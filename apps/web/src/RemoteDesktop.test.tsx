import { act, render } from "@testing-library/react";
import type { SessionSummary } from "@vnc-cua/contracts";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { RemoteDesktop } from "./RemoteDesktop.js";

const { mockRfbInstances, MockRfb } = vi.hoisted(() => {
  const instances: MockRfb[] = [];

  class HoistedMockRfb extends EventTarget {
    background = "";
    clipViewport = false;
    compressionLevel = 0;
    qualityLevel = 0;
    scaleViewport = false;
    showDotCursor = false;
    viewOnly = false;
    readonly disconnect = vi.fn();
    readonly focus = vi.fn();

    constructor(
      public readonly target: HTMLElement,
      public readonly urlOrChannel: string | WebSocket,
      public readonly options?: { credentials?: { password?: string }; shared?: boolean },
    ) {
      super();
      instances.push(this as unknown as MockRfb);
    }
  }

  type MockRfb = HoistedMockRfb;

  return {
    mockRfbInstances: instances,
    MockRfb: HoistedMockRfb,
  };
});

vi.mock("./lib/novnc.js", () => ({
  RFB: MockRfb,
}));

function makeSession(): SessionSummary {
  return {
    id: "session-1",
    title: "Sandbox 1",
    sandboxId: "sbx-session-1",
    sandboxStatus: "running",
    runState: "ready",
    lastScreenshotRevision: 1,
    createdAt: "2026-04-13T12:00:00.000Z",
    updatedAt: "2026-04-13T12:00:10.000Z",
    terminatedAt: null,
  };
}

describe("RemoteDesktop", () => {
  beforeEach(() => {
    mockRfbInstances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects automatically after the VNC stream disconnects", async () => {
    render(
      <RemoteDesktop
        interactiveEnabled
        session={makeSession()}
        streamEnabled
      />,
    );

    expect(mockRfbInstances).toHaveLength(1);

    await act(async () => {
      mockRfbInstances[0]?.dispatchEvent(
        new CustomEvent("disconnect", {
          detail: { clean: false },
        }),
      );
      vi.advanceTimersByTime(750);
    });

    expect(mockRfbInstances).toHaveLength(2);
    expect(mockRfbInstances[1]?.urlOrChannel).toBe(
      "ws://localhost:3000/api/sessions/session-1/vnc",
    );
  });
});
