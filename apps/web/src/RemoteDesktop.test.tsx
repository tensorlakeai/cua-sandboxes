import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const { mockRfbInstances, mockWebSocketInstances, MockRfb, MockWebSocket } = vi.hoisted(() => {
  const instances: MockRfb[] = [];
  const sockets: MockWebSocket[] = [];

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

  class HoistedMockWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly sent = vi.fn();
    readyState = HoistedMockWebSocket.CONNECTING;

    constructor(public readonly url: string) {
      super();
      sockets.push(this as unknown as MockWebSocket);
    }

    send(data: string) {
      this.sent(data);
    }

    close() {
      this.readyState = HoistedMockWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }

    open() {
      this.readyState = HoistedMockWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }
  }

  type MockWebSocket = HoistedMockWebSocket;

  return {
    mockRfbInstances: instances,
    mockWebSocketInstances: sockets,
    MockRfb: HoistedMockRfb,
    MockWebSocket: HoistedMockWebSocket,
  };
});

vi.mock("./lib/novnc.js", () => ({
  RFB: MockRfb,
}));

let drawImageMock: ReturnType<typeof vi.fn>;

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: overrides.id ?? "session-1",
    title: overrides.title ?? "Sandbox 1",
    sandboxId: overrides.sandboxId ?? "sbx-session-1",
    sandboxStatus: overrides.sandboxStatus ?? "running",
    runState: overrides.runState ?? "ready",
    lastScreenshotRevision: overrides.lastScreenshotRevision ?? 1,
    createdAt: overrides.createdAt ?? "2026-04-13T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-13T12:00:10.000Z",
    terminatedAt: overrides.terminatedAt ?? null,
  };
}

describe("RemoteDesktop", () => {
  beforeEach(() => {
    mockRfbInstances.length = 0;
    mockWebSocketInstances.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
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
    vi.unstubAllGlobals();
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

  it("routes navigation keys through the input socket as real arrow presses", async () => {
    render(
      <RemoteDesktop
        interactiveEnabled
        session={makeSession()}
        streamEnabled
      />,
    );

    const host = screen.getByLabelText("Interactive live desktop");
    fireEvent.mouseDown(host);

    expect(mockWebSocketInstances).toHaveLength(1);
    mockWebSocketInstances[0]?.open();
    const stage = host.firstElementChild as HTMLElement;

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
      shiftKey: true,
    });

    stage.dispatchEvent(event);

    expect(mockWebSocketInstances[0]?.url).toBe(
      "ws://localhost:3000/api/sessions/session-1/input",
    );
    expect(mockWebSocketInstances[0]?.sent).toHaveBeenCalledWith(
      JSON.stringify({
        type: "key_press",
        key: "ArrowDown",
        modifiers: ["Shift"],
      }),
    );
  });

  it("restores interactive focus after a run switches the desktop back from view-only", async () => {
    const { rerender } = render(
      <RemoteDesktop
        interactiveEnabled
        session={makeSession({ runState: "ready" })}
        streamEnabled
      />,
    );

    const interactiveHost = screen.getByLabelText("Interactive live desktop");
    fireEvent.mouseDown(interactiveHost);

    expect(mockRfbInstances[0]?.focus).toHaveBeenCalledTimes(1);
    expect(mockRfbInstances[0]?.viewOnly).toBe(false);

    rerender(
      <RemoteDesktop
        interactiveEnabled
        session={makeSession({ runState: "running" })}
        streamEnabled
      />,
    );

    expect(screen.getByLabelText("Live desktop")).toBeInTheDocument();
    expect(mockRfbInstances[0]?.viewOnly).toBe(true);

    await act(async () => {
      rerender(
        <RemoteDesktop
          interactiveEnabled
          session={makeSession({ runState: "ready" })}
          streamEnabled
        />,
      );
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Interactive live desktop")).toBeInTheDocument();
    expect(mockRfbInstances[0]?.viewOnly).toBe(false);
    expect(mockRfbInstances[0]?.focus).toHaveBeenCalledTimes(2);
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
