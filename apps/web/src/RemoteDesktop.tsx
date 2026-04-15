import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "@vnc-cua/contracts";

import { RFB } from "./lib/novnc.js";

const RECONNECT_DELAY_MS = 750;
const VNC_PASSWORD = "tensorlake";

interface RemoteDesktopProps {
  session: SessionSummary | null;
  streamEnabled: boolean;
  interactiveEnabled: boolean;
  className?: string;
}

export function RemoteDesktop({
  session,
  streamEnabled,
  interactiveEnabled,
  className,
}: RemoteDesktopProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const [connectionGeneration, setConnectionGeneration] = useState(0);

  const canShowLiveDesktop = session != null
    && session.terminatedAt === null
    && session.runState !== "pending"
    && streamEnabled;
  const canControl = session != null
    && session.terminatedAt === null
    && session.runState !== "pending"
    && session.runState !== "running"
    && session.runState !== "stopping"
    && interactiveEnabled;
  const vncUrl = useMemo(() => {
    if (!session || !canShowLiveDesktop) {
      return null;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/sessions/${session.id}/vnc`;
  }, [canShowLiveDesktop, session?.id]);
  const imageUrl = useMemo(() => {
    if (!session) {
      return null;
    }

    if (session.lastScreenshotRevision > 0) {
      return `/api/sessions/${session.id}/screenshot?rev=${session.lastScreenshotRevision}`;
    }

    return null;
  }, [session]);

  useEffect(() => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    setConnectionGeneration(0);
  }, [session?.id]);

  useEffect(() => () => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !canShowLiveDesktop || !session || !vncUrl) {
      if (rfbRef.current) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
      }
      if (surface) {
        clearSurface(surface);
      }
      return;
    }

    clearSurface(surface);

    const rfb = new RFB(
      surface,
      vncUrl,
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
    rfb.viewOnly = !canControl;

    const handleConnect = () => {
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
    const handleDisconnect = () => {
      if (reconnectTimeoutRef.current !== null) {
        return;
      }

      reconnectTimeoutRef.current = window.setTimeout(() => {
        reconnectTimeoutRef.current = null;
        setConnectionGeneration((current) => current + 1);
      }, RECONNECT_DELAY_MS);
    };

    rfb.addEventListener("connect", handleConnect);
    rfb.addEventListener("disconnect", handleDisconnect);
    rfbRef.current = rfb;

    return () => {
      rfb.removeEventListener("connect", handleConnect);
      rfb.removeEventListener("disconnect", handleDisconnect);
      if (rfbRef.current === rfb) {
        rfbRef.current = null;
      }
      rfb.disconnect();
      clearSurface(surface);
    };
  }, [canShowLiveDesktop, connectionGeneration, session?.id, vncUrl]);

  useEffect(() => {
    if (rfbRef.current) {
      rfbRef.current.viewOnly = !canControl;
    }
  }, [canControl]);

  function handleMouseDown() {
    rfbRef.current?.focus();
  }

  return (
    <div className={className}>
      {canShowLiveDesktop ? (
        <div
          aria-label={canControl ? "Interactive live desktop" : "Live desktop"}
          className="h-full border border-white/10 bg-black"
          onMouseDown={handleMouseDown}
          ref={surfaceRef}
        />
      ) : imageUrl ? (
        <div
          aria-label="Desktop screenshot"
          className="h-full border border-white/10 bg-black"
        >
          <img
            alt={session?.title ?? "Desktop screenshot"}
            className="h-full w-full object-contain"
            src={imageUrl}
          />
        </div>
      ) : session?.runState === "pending" ? (
        <div className="flex h-full flex-col items-center justify-center border border-dashed border-amber-300/20 bg-amber-300/6 px-6 text-center">
          <p className="text-base font-medium text-amber-50">
            Sandbox booting
          </p>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center border border-dashed border-white/10 bg-white/3 px-6 text-center text-sm text-stone-400">
          Create a sandbox to see its live desktop here.
        </div>
      )}
    </div>
  );
}

function clearSurface(surface: HTMLDivElement): void {
  surface.textContent = "";
}
