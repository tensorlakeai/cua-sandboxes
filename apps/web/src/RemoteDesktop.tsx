import { useEffect, useMemo, useRef } from "react";
import type { SessionSummary } from "@vnc-cua/contracts";

import { acquireLiveDesktopHandle, type LiveDesktopHandle } from "./live-desktop-manager.js";

interface RemoteDesktopProps {
  session: SessionSummary | null;
  streamEnabled: boolean;
  interactiveEnabled: boolean;
  className?: string;
  displayPriority?: number;
}

export function RemoteDesktop({
  session,
  streamEnabled,
  interactiveEnabled,
  className,
  displayPriority = 0,
}: RemoteDesktopProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const attachmentIdRef = useRef(Symbol("remote-desktop-attachment"));
  const connectionRef = useRef<LiveDesktopHandle | null>(null);

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
    const surface = surfaceRef.current;
    const attachmentId = attachmentIdRef.current;

    if (!surface || !canShowLiveDesktop || !session || !vncUrl) {
      connectionRef.current?.detach(attachmentId);
      connectionRef.current = null;
      if (surface) {
        surface.textContent = "";
      }
      return;
    }

    const handle = acquireLiveDesktopHandle(session.id, vncUrl);
    connectionRef.current = handle;

    return () => {
      handle.detach(attachmentId);
      if (connectionRef.current === handle) {
        connectionRef.current = null;
      }
    };
  }, [canShowLiveDesktop, session?.id, vncUrl]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const handle = connectionRef.current;
    if (!surface || !handle || !canShowLiveDesktop) {
      return;
    }

    handle.attach(attachmentIdRef.current, {
      canControl,
      host: surface,
      priority: displayPriority,
    });
  }, [canControl, canShowLiveDesktop, displayPriority, session?.id]);

  function handleMouseDown() {
    connectionRef.current?.focus();
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
