import { RFB } from "./lib/novnc.js";

const RECONNECT_DELAY_MS = 750;
const FALLBACK_SNAPSHOT_INTERVAL_MS = 200;
const VNC_PASSWORD = "tensorlake";

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
  readonly vncUrl: string;

  private rfb: RFB | null = null;
  private reconnectTimeoutId: number | null = null;
  private snapshotTimeoutId: number | null = null;
  private nextOrder = 0;
  private disposed = false;
  private activeConnectionToken = 0;

  constructor(
    private readonly sessionId: string,
    vncUrl: string,
  ) {
    this.vncUrl = vncUrl;
    this.stage = document.createElement("div");
    this.stage.className = "relative h-full w-full overflow-hidden bg-black";
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
    this.rfb?.focus();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearReconnectTimer();
    this.stopSnapshotLoop();
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
      this.rfb.viewOnly = !activeAttachment.canControl;
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
}
