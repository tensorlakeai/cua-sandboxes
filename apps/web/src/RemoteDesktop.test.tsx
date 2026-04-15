import { act, cleanup, render, screen } from "@testing-library/react";
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

let drawImageMock: ReturnType<typeof vi.fn>;

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
    drawImageMock = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => (
      { drawImage: drawImageMock } as unknown as CanvasRenderingContext2D
    ));
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
      () => "data:image/png;base64,frame",
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reconnects automatically after the shared VNC stream disconnects", async () => {
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

  it("keeps the last rendered frame visible while reconnecting", async () => {
    render(
      <RemoteDesktop
        interactiveEnabled
        session={makeSession()}
        streamEnabled
      />,
    );

    const host = screen.getByLabelText("Interactive live desktop");
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = 1280;
    sourceCanvas.height = 800;
    mockRfbInstances[0]?.target.append(sourceCanvas);

    await act(async () => {
      mockRfbInstances[0]?.dispatchEvent(new Event("connect"));
      vi.advanceTimersByTime(200);
    });

    const fallbackImage = host.querySelector("img");
    expect(drawImageMock).toHaveBeenCalled();
    expect(fallbackImage).toHaveClass("hidden");

    await act(async () => {
      mockRfbInstances[0]?.dispatchEvent(
        new CustomEvent("disconnect", {
          detail: { clean: false },
        }),
      );
    });

    expect(fallbackImage).not.toHaveClass("hidden");
    expect(fallbackImage?.getAttribute("src")).toBe("data:image/png;base64,frame");
  });

  it("reuses one VNC connection while moving the live surface into the popup host", () => {
    const session = makeSession();
    const { rerender } = render(
      <>
        <RemoteDesktop
          displayPriority={0}
          interactiveEnabled={false}
          session={session}
          streamEnabled
        />
        <RemoteDesktop
          displayPriority={10}
          interactiveEnabled
          session={session}
          streamEnabled
        />
      </>,
    );

    const popupHost = screen.getByLabelText("Interactive live desktop");

    expect(mockRfbInstances).toHaveLength(1);
    expect(mockRfbInstances[0]?.target.parentElement?.parentElement).toBe(popupHost);

    rerender(
      <RemoteDesktop
        displayPriority={0}
        interactiveEnabled
        session={session}
        streamEnabled
      />,
    );

    const returnedHost = screen.getByLabelText("Interactive live desktop");
    expect(mockRfbInstances).toHaveLength(1);
    expect(mockRfbInstances[0]?.target.parentElement?.parentElement).toBe(returnedHost);
  });
});
