import type { LiveModifierKey } from "@vnc-cua/contracts";

import { RFB } from "./lib/novnc.js";

const RECONNECT_DELAY_MS = 750;
const FALLBACK_SNAPSHOT_INTERVAL_MS = 200;
const VNC_PASSWORD = "tensorlake";
const NAVIGATION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

interface AttachmentOptions {
  canControl: boolean;
  host: HTMLDivElement;
  priority: number;
}

interface AttachmentRecord extends AttachmentOptions {
  order: number;
}

const connections = new Map<string, ManagedDesktopConnection>();

export interface LiveDesktopHandle {
  attach(id: symbol, options: AttachmentOptions): void;
  detach(id: symbol): void;
  focus(): void;
}

export function acquireLiveDesktopHandle(
  sessionId: string,
  vncUrl: string,
): LiveDesktopHandle {
  const existing = connections.get(sessionId);
  if (existing && existing.vncUrl === vncUrl) {
    return existing;
  }

  existing?.dispose();

  const created = new ManagedDesktopConnection(sessionId, vncUrl);
  connections.set(sessionId, created);
  return created;
}

class ManagedDesktopConnection implements LiveDesktopHandle {
  readonly stage: HTMLDivElement;
  readonly liveSurface: HTMLDivElement;
  readonly fallbackImage: HTMLImageElement;
  readonly snapshotCanvas: HTMLCanvasElement;
  readonly attachments = new Map<symbol, AttachmentRecord>();
  readonly inputUrl: string;
  readonly vncUrl: string;

  private rfb: RFB | null = null;
  private inputSocket: WebSocket | null = null;
  private reconnectTimeoutId: number | null = null;
  private snapshotTimeoutId: number | null = null;
  private nextOrder = 0;
  private disposed = false;
  private activeConnectionToken = 0;
  private pendingInputMessages: string[] = [];
  private wantsInteractiveFocus = false;

  constructor(
    private readonly sessionId: string,
    vncUrl: string,
  ) {
    this.vncUrl = vncUrl;
    this.inputUrl = deriveInputUrl(vncUrl);
    this.stage = document.createElement("div");
    this.stage.className = "relative h-full w-full overflow-hidden bg-black";
    this.stage.addEventListener("keydown", this.handleStageKeyDown, true);
    this.stage.addEventListener("keyup", this.handleStageKeyUp, true);
    this.liveSurface = document.createElement("div");
    this.liveSurface.className = "absolute inset-0 h-full w-full transition-opacity duration-150";
    this.fallbackImage = document.createElement("img");
    this.fallbackImage.alt = "";
    this.fallbackImage.className = "pointer-events-none absolute inset-0 z-10 hidden h-full w-full object-contain";
    this.fallbackImage.draggable = false;
    this.snapshotCanvas = document.createElement("canvas");
    this.stage.append(this.fallbackImage, this.liveSurface);
  }

  attach(id: symbol, options: AttachmentOptions): void {
    if (this.disposed) {
      return;
    }

    this.attachments.set(id, {
      ...options,
      order: this.nextOrder += 1,
    });
    this.sync();
  }

  detach(id: symbol): void {
    if (this.disposed) {
      return;
    }

    this.attachments.delete(id);

    if (this.attachments.size === 0) {
      this.dispose();
      return;
    }

    this.sync();
  }

  focus(): void {
    this.wantsInteractiveFocus = true;
    this.ensureInputSocket();
    if (this.rfb && !this.rfb.viewOnly) {
      this.rfb.focus();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearReconnectTimer();
    this.stopSnapshotLoop();
    this.disconnectInputSocket();
    this.stage.removeEventListener("keydown", this.handleStageKeyDown, true);
    this.stage.removeEventListener("keyup", this.handleStageKeyUp, true);
    this.disconnectCurrent();
    this.stage.remove();

    if (connections.get(this.sessionId) === this) {
      connections.delete(this.sessionId);
    }
  }

  private sync(): void {
    const activeAttachment = this.getActiveAttachment();
    if (!activeAttachment) {
      return;
    }

    if (this.stage.parentElement !== activeAttachment.host) {
      activeAttachment.host.replaceChildren(this.stage);
    }

    if (this.rfb) {
      const controlRestored = this.rfb.viewOnly && activeAttachment.canControl;
      this.rfb.viewOnly = !activeAttachment.canControl;
      if (activeAttachment.canControl) {
        this.ensureInputSocket();
        if (controlRestored && this.wantsInteractiveFocus) {
          queueMicrotask(() => {
            if (this.disposed || !this.rfb || this.rfb.viewOnly) {
              return;
            }
            this.rfb.focus();
          });
        }
      } else {
        if (this.stage.contains(document.activeElement)) {
          this.wantsInteractiveFocus = true;
        }
        this.disconnectInputSocket();
      }
      return;
    }

    if (this.reconnectTimeoutId === null) {
      this.connect();
    }
  }

  private connect(): void {
    if (this.disposed || this.rfb) {
      return;
    }

    const activeAttachment = this.getActiveAttachment();
    if (!activeAttachment) {
      return;
    }

    if (this.stage.parentElement !== activeAttachment.host) {
      activeAttachment.host.replaceChildren(this.stage);
    }

    this.liveSurface.textContent = "";
    this.prepareForReconnect();
    const connectionToken = this.activeConnectionToken += 1;
    const rfb = new RFB(
      this.liveSurface,
      this.vncUrl,
      {
        credentials: { password: VNC_PASSWORD },
        shared: true,
      },
    );
    rfb.background = "rgb(0, 0, 0)";
    rfb.clipViewport = false;
    rfb.compressionLevel = 1;
    rfb.qualityLevel = 6;
    rfb.scaleViewport = true;
    rfb.showDotCursor = true;
    rfb.viewOnly = !activeAttachment.canControl;

    const handleConnect = () => {
      if (this.rfb !== rfb || this.disposed) {
        return;
      }
      this.clearReconnectTimer();
      const activeAttachmentAfterConnect = this.getActiveAttachment();
      if (activeAttachmentAfterConnect?.canControl) {
        this.ensureInputSocket();
        if (this.wantsInteractiveFocus) {
          queueMicrotask(() => {
            if (this.rfb !== rfb || this.disposed || rfb.viewOnly) {
              return;
            }
            rfb.focus();
          });
        }
      }
      this.startSnapshotLoop();
    };

    const handleDisconnect = () => {
      if (this.rfb !== rfb || this.disposed) {
        return;
      }

      this.stopSnapshotLoop();
      this.captureFallbackFrame();
      rfb.removeEventListener("connect", handleConnect);
      rfb.removeEventListener("disconnect", handleDisconnect);
      this.rfb = null;
      this.scheduleReconnect(connectionToken);
    };

    rfb.addEventListener("connect", handleConnect);
    rfb.addEventListener("disconnect", handleDisconnect);
    this.rfb = rfb;
  }

  private scheduleReconnect(connectionToken: number): void {
    if (this.reconnectTimeoutId !== null || this.disposed || this.attachments.size === 0) {
      return;
    }

    this.reconnectTimeoutId = window.setTimeout(() => {
      this.reconnectTimeoutId = null;
      if (this.disposed || this.attachments.size === 0) {
        return;
      }

      if (connectionToken !== this.activeConnectionToken) {
        return;
      }

      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private disconnectCurrent(): void {
    const current = this.rfb;
    this.rfb = null;
    this.stopSnapshotLoop();
    current?.disconnect();
  }

  private disconnectInputSocket(): void {
    const socket = this.inputSocket;
    this.inputSocket = null;
    socket?.close();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimeoutId === null) {
      return;
    }

    window.clearTimeout(this.reconnectTimeoutId);
    this.reconnectTimeoutId = null;
  }

  private startSnapshotLoop(): void {
    if (this.snapshotTimeoutId !== null || this.disposed || !this.rfb) {
      return;
    }

    const tick = () => {
      this.snapshotTimeoutId = null;
      if (this.disposed || !this.rfb) {
        return;
      }

      this.syncSnapshotFromLive();
      this.snapshotTimeoutId = window.setTimeout(
        tick,
        FALLBACK_SNAPSHOT_INTERVAL_MS,
      );
    };

    this.syncSnapshotFromLive();
    this.snapshotTimeoutId = window.setTimeout(
      tick,
      FALLBACK_SNAPSHOT_INTERVAL_MS,
    );
  }

  private stopSnapshotLoop(): void {
    if (this.snapshotTimeoutId === null) {
      return;
    }

    window.clearTimeout(this.snapshotTimeoutId);
    this.snapshotTimeoutId = null;
  }

  private getActiveAttachment(): AttachmentRecord | null {
    let active: AttachmentRecord | null = null;

    for (const attachment of this.attachments.values()) {
      if (
        !active ||
        attachment.priority > active.priority ||
        (attachment.priority === active.priority && attachment.order > active.order)
      ) {
        active = attachment;
      }
    }

    return active;
  }

  private captureFallbackFrame(): void {
    if (this.snapshotCanvas.width === 0 || this.snapshotCanvas.height === 0) {
      return;
    }

    try {
      this.fallbackImage.src = this.snapshotCanvas.toDataURL("image/png");
      this.liveSurface.classList.add("opacity-0");
      this.fallbackImage.classList.remove("hidden");
    } catch {
      // Ignore snapshot failures and fall back to the live surface.
    }
  }

  private hideFallback(): void {
    this.liveSurface.classList.remove("opacity-0");
    this.fallbackImage.classList.add("hidden");
  }

  private prepareForReconnect(): void {
    if (this.snapshotCanvas.width === 0 || this.snapshotCanvas.height === 0) {
      this.liveSurface.classList.remove("opacity-0");
      return;
    }

    this.captureFallbackFrame();
  }

  private syncSnapshotFromLive(): void {
    const source = this.liveSurface.querySelector("canvas");
    if (!(source instanceof HTMLCanvasElement)) {
      return;
    }
    if (source.width === 0 || source.height === 0) {
      return;
    }

    if (
      this.snapshotCanvas.width !== source.width ||
      this.snapshotCanvas.height !== source.height
    ) {
      this.snapshotCanvas.width = source.width;
      this.snapshotCanvas.height = source.height;
    }

    const context = this.snapshotCanvas.getContext("2d");
    if (!context) {
      return;
    }

    try {
      context.drawImage(source, 0, 0);
      this.hideFallback();
    } catch {
      // Ignore snapshot failures and continue with the current display.
    }
  }

  private readonly handleStageKeyDown = (event: KeyboardEvent): void => {
    if (!this.shouldInterceptNavigationKey(event)) {
      return;
    }

    stopKeyboardEvent(event);
    this.sendLiveInput({
      type: "key_press",
      key: event.key,
      modifiers: modifiersFromKeyboardEvent(event),
    });
  };

  private readonly handleStageKeyUp = (event: KeyboardEvent): void => {
    if (!this.shouldInterceptNavigationKey(event)) {
      return;
    }

    stopKeyboardEvent(event);
  };

  private shouldInterceptNavigationKey(event: KeyboardEvent): boolean {
    if (!NAVIGATION_KEYS.has(event.key)) {
      return false;
    }

    const activeAttachment = this.getActiveAttachment();
    return !!activeAttachment?.canControl;
  }

  private ensureInputSocket(): void {
    if (this.disposed) {
      return;
    }

    if (
      this.inputSocket &&
      (this.inputSocket.readyState === WebSocket.OPEN
        || this.inputSocket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const socket = new WebSocket(this.inputUrl);
    socket.addEventListener("open", () => {
      if (this.inputSocket !== socket || this.disposed) {
        socket.close();
        return;
      }

      this.flushPendingInputMessages();
    });
    socket.addEventListener("close", () => {
      if (this.inputSocket === socket) {
        this.inputSocket = null;
      }
    });
    socket.addEventListener("error", () => {
      if (this.inputSocket === socket && socket.readyState !== WebSocket.OPEN) {
        this.inputSocket = null;
      }
    });
    this.inputSocket = socket;
  }

  private flushPendingInputMessages(): void {
    if (!this.inputSocket || this.inputSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (this.pendingInputMessages.length > 0) {
      const next = this.pendingInputMessages.shift();
      if (next == null) {
        break;
      }
      this.inputSocket.send(next);
    }
  }

  private sendLiveInput(payload: {
    type: "key_press";
    key: string;
    modifiers: LiveModifierKey[];
  }): void {
    const serialized = JSON.stringify(payload);
    if (this.inputSocket?.readyState === WebSocket.OPEN) {
      this.inputSocket.send(serialized);
      return;
    }

    this.pendingInputMessages.push(serialized);
    this.ensureInputSocket();
  }
}

function deriveInputUrl(vncUrl: string): string {
  const url = new URL(vncUrl);
  url.pathname = url.pathname.replace(/\/vnc$/, "/input");
  return url.toString();
}

function modifiersFromKeyboardEvent(event: KeyboardEvent): LiveModifierKey[] {
  const modifiers: LiveModifierKey[] = [];

  if (event.altKey && event.key !== "Alt") {
    modifiers.push("Alt");
  }
  if (event.ctrlKey && event.key !== "Control") {
    modifiers.push("Control");
  }
  if (event.metaKey && event.key !== "Meta") {
    modifiers.push("Meta");
  }
  if (event.shiftKey && event.key !== "Shift") {
    modifiers.push("Shift");
  }

  return modifiers;
}

function stopKeyboardEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}
