import * as ScrollArea from "@radix-ui/react-scroll-area";
import * as Tabs from "@radix-ui/react-tabs";
import {
  sseEventSchema,
  type ChatMessage,
  type SessionSummary,
} from "@vnc-cua/contracts";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  closeSession,
  createSession,
  deleteArchivedSession,
  listMessages,
  listSessions,
  sendMessage,
  stopSession,
} from "./api.js";
import { RemoteDesktop } from "./RemoteDesktop.js";

type MessageMap = Record<string, ChatMessage[]>;

const EVENT_TYPES = [
  "session.upsert",
  "session.deleted",
  "session.terminated",
  "message.created",
  "screenshot.updated",
  "run.state",
  "error",
] as const;
const LIVE_CONNECTION_MESSAGE = "Lost the live connection. Waiting to reconnect...";

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [messagesBySession, setMessagesBySession] = useState<MessageMap>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isDesktopOverlayOpen, setIsDesktopOverlayOpen] = useState(false);
  const [isVisitorReady, setIsVisitorReady] = useState(false);
  const chatViewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadInitialState();
  }, []);

  const activeSessions = useMemo(
    () => sortSessions(sessions.filter((session) => session.terminatedAt === null)),
    [sessions],
  );
  const archivedSessions = useMemo(
    () => sortSessions(sessions.filter((session) => session.terminatedAt !== null)),
    [sessions],
  );

  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ??
    activeSessions[0] ??
    archivedSessions[0] ??
    null;
  const activeTabValue = activeSessions.some((session) => session.id === selectedSessionId)
    ? selectedSessionId ?? ""
    : "";

  useEffect(() => {
    if (!selectedSession && sessions.length === 0) {
      setSelectedSessionId(null);
      return;
    }

    if (!selectedSession && (activeSessions[0] ?? archivedSessions[0])) {
      setSelectedSessionId((activeSessions[0] ?? archivedSessions[0])!.id);
    }
  }, [activeSessions, archivedSessions, selectedSession, sessions.length]);

  useEffect(() => {
    if (!selectedSession || messagesBySession[selectedSession.id]) {
      return;
    }

    void listMessages(selectedSession.id).then((response) => {
      startTransition(() => {
        setMessagesBySession((current) => ({
          ...current,
          [selectedSession.id]: response.messages,
        }));
      });
    }).catch((error: unknown) => {
      setStatusMessage(error instanceof Error ? error.message : "Failed to load messages");
    });
  }, [messagesBySession, selectedSession]);

  useEffect(() => {
    if (!activeSessions.some((session) => session.runState === "pending")) {
      return;
    }

    const interval = window.setInterval(() => {
      void listSessions().then((response) => {
        startTransition(() => {
          setSessions(sortSessions(response.sessions));
        });
      }).catch(() => {});
    }, 3_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeSessions]);

  useEffect(() => {
    if (
      !selectedSession ||
      selectedSession.terminatedAt !== null ||
      selectedSession.runState === "pending"
    ) {
      setIsDesktopOverlayOpen(false);
    }
  }, [selectedSession]);

  const handleEvent = useEffectEvent((event: MessageEvent<string>) => {
    const parsed = sseEventSchema.safeParse(JSON.parse(event.data));
    if (!parsed.success) {
      return;
    }

    const data = parsed.data;

    startTransition(() => {
      switch (data.type) {
        case "session.upsert":
          setSessions((current) => upsertSession(current, data.session));
          if (!selectedSessionId) {
            setSelectedSessionId(data.session.id);
          }
          break;
        case "session.deleted":
          setSessions((current) => removeSession(current, data.sessionId));
          setMessagesBySession((current) => removeMessagesForSession(current, data.sessionId));
          setSelectedSessionId((current) =>
            current === data.sessionId ? null : current,
          );
          break;
        case "session.terminated":
          setStatusMessage("Sandbox terminated.");
          break;
        case "message.created":
          setMessagesBySession((current) => ({
            ...current,
            [data.message.sessionId]: [
              ...(current[data.message.sessionId] ?? []),
              data.message,
            ],
          }));
          break;
        case "screenshot.updated":
          setSessions((current) =>
            current.map((session) =>
              session.id === data.sessionId
                ? {
                    ...session,
                    lastScreenshotRevision: data.revision,
                    updatedAt: data.updatedAt,
                  }
                : session,
            ),
          );
          break;
        case "run.state":
          setSessions((current) =>
            current.map((session) =>
              session.id === data.sessionId
                ? { ...session, runState: data.runState }
                : session,
            ),
          );
          break;
        case "error":
          setStatusMessage(data.message);
          break;
      }
    });
  });

  const handleStreamOpen = useEffectEvent(() => {
    setStatusMessage((current) =>
      current === LIVE_CONNECTION_MESSAGE ? null : current,
    );
  });

  const handleStreamError = useEffectEvent(() => {
    if (selectedSession?.terminatedAt !== null) {
      return;
    }

    setStatusMessage(LIVE_CONNECTION_MESSAGE);
  });

  useEffect(() => {
    if (!isVisitorReady) {
      return;
    }

    const source = new EventSource("/api/events");

    for (const eventType of EVENT_TYPES) {
      source.addEventListener(eventType, handleEvent as EventListener);
    }

    source.onopen = handleStreamOpen;
    source.onerror = handleStreamError;

    return () => {
      source.close();
    };
  }, [handleEvent, handleStreamError, handleStreamOpen, isVisitorReady]);

  async function loadInitialState() {
    try {
      const response = await listSessions();
      setSessions(sortSessions(response.sessions));
      setSelectedSessionId(response.sessions[0]?.id ?? null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to load sessions");
    } finally {
      setIsVisitorReady(true);
    }
  }

  async function handleCreateSession() {
    setIsCreating(true);
    try {
      const response = await createSession();
      setSessions((current) => upsertSession(current, response.session));
      setSelectedSessionId(response.session.id);
      setStatusMessage(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to create session");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleSubmitMessage() {
    if (!selectedSession || selectedSession.terminatedAt || !composer.trim()) {
      return;
    }

    try {
      const response = await sendMessage(selectedSession.id, composer);
      setSessions((current) => upsertSession(current, response.session));
      setComposer("");
      setStatusMessage(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to send message");
    }
  }

  async function handleStopSession() {
    if (!selectedSession) {
      return;
    }

    try {
      const response = await stopSession(selectedSession.id);
      setSessions((current) => upsertSession(current, response.session));
      setStatusMessage(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to stop run");
    }
  }

  async function handleCloseSession(sessionId: string) {
    try {
      const response = await closeSession(sessionId);
      setSessions((current) => upsertSession(current, response.session));
      const nextSession =
        activeSessions.find((session) => session.id !== sessionId) ??
        archivedSessions[0] ??
        null;
      setSelectedSessionId(nextSession?.id ?? null);
      setStatusMessage(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to close session");
    }
  }

  async function handleDeleteArchivedSession(sessionId: string) {
    try {
      const remainingSessions = removeSession(sessions, sessionId);
      await deleteArchivedSession(sessionId);
      setSessions(remainingSessions);
      setMessagesBySession((current) => removeMessagesForSession(current, sessionId));
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(preferredSessionId(remainingSessions));
      }
      setStatusMessage(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to delete archived session");
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    void handleSubmitMessage();
  }

  const selectedMessages = selectedSession
    ? (messagesBySession[selectedSession.id] ?? [])
    : [];
  const latestSystemMessageId = useMemo(() => {
    for (let index = selectedMessages.length - 1; index >= 0; index -= 1) {
      const message = selectedMessages[index];
      if (message?.role === "system") {
        return message.id;
      }
    }

    return null;
  }, [selectedMessages]);
  const isArchivedSelection = selectedSession?.terminatedAt !== null;
  const canPopOutDesktop = selectedSession != null
    && selectedSession.terminatedAt === null
    && selectedSession.runState !== "pending";
  const composerDisabled =
    !selectedSession ||
    selectedSession.terminatedAt !== null ||
    selectedSession.runState === "pending" ||
    selectedSession.runState === "running" ||
    selectedSession.runState === "stopping";

  useEffect(() => {
    if (isArchivedSelection) {
      setStatusMessage((current) =>
        current === LIVE_CONNECTION_MESSAGE ? null : current,
      );
    }
  }, [isArchivedSelection]);

  useEffect(() => {
    const viewport = chatViewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [selectedSession?.id, selectedMessages.length]);

  return (
    <div className="h-screen overflow-hidden px-4 py-4 text-stone-100 md:px-6">
      <div className="mx-auto flex h-full max-w-[1600px] flex-col overflow-hidden rounded-[32px] border border-white/10 bg-stone-950/75 shadow-[0_24px_90px_rgba(0,0,0,0.45)] backdrop-blur">
        <header className="border-b border-white/10 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
                Tensorlake CUA Sandboxes
              </h1>
            </div>
            <button
              className="rounded-full bg-amber-300 px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-amber-300/60"
              disabled={isCreating}
              onClick={() => void handleCreateSession()}
              type="button"
            >
              {isCreating ? "Starting..." : "+ New sandbox"}
            </button>
          </div>
          {statusMessage ? (
            <p className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
              {statusMessage}
            </p>
          ) : null}
        </header>

        <div className="border-b border-white/10 px-4 py-3">
          <Tabs.Root
            onValueChange={setSelectedSessionId}
            value={activeTabValue}
          >
            <Tabs.List className="flex flex-wrap gap-2">
              {activeSessions.map((session) => (
                <div
                  className="flex items-center"
                  key={session.id}
                >
                  <Tabs.Trigger
                    className="group flex items-center gap-3 rounded-l-full border border-r-0 border-white/10 bg-white/5 px-4 py-2 text-sm text-stone-200 transition hover:border-teal-300/40 hover:bg-teal-300/8 data-[state=active]:border-teal-300/70 data-[state=active]:bg-teal-300/18 data-[state=active]:text-white"
                    value={session.id}
                  >
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        session.runState === "running"
                          ? "bg-amber-300"
                          : session.runState === "error"
                            ? "bg-rose-400"
                            : "bg-teal-300"
                      }`}
                    />
                    <span>{session.title}</span>
                  </Tabs.Trigger>
                  <button
                    aria-label={`Close ${session.title}`}
                    className="rounded-r-full border border-white/10 border-l-white/10 bg-white/5 px-3 py-2 text-sm text-stone-400 transition hover:border-teal-300/40 hover:bg-white/10 hover:text-white"
                    onClick={() => {
                      void handleCloseSession(session.id);
                    }}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </Tabs.List>
          </Tabs.Root>
        </div>

        <div className="grid-shell min-h-0 flex-1 overflow-hidden">
          <section className="flex min-h-0 flex-col border-b border-white/10 md:border-b-0 md:border-r">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div>
                <h2 className="text-lg font-medium text-stone-100">
                  {selectedSession?.title ?? "No session selected"}
                </h2>
                <p className="text-sm text-stone-400">
                  {selectedSession
                    ? selectedSession.terminatedAt
                      ? "Archived transcript"
                      : selectedSession.runState === "pending"
                        ? "Sandbox booting"
                      : `Sandbox status: ${selectedSession.sandboxStatus}`
                    : "Start a sandbox to begin."}
                </p>
              </div>
              {selectedSession && selectedSession.terminatedAt === null ? (
                <button
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-stone-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={
                    selectedSession.runState === "pending" ||
                    selectedSession.runState === "stopping"
                  }
                  onClick={() => void handleStopSession()}
                  type="button"
                >
                  {selectedSession.runState === "running" ||
                  selectedSession.runState === "stopping"
                    ? "Stop run"
                    : "Stop"}
                </button>
              ) : null}
            </div>

            <ScrollArea.Root className="min-h-0 flex-1 overflow-hidden">
              <ScrollArea.Viewport
                className="h-full overscroll-contain px-5 py-5"
                data-testid="chat-scroll-viewport"
                ref={chatViewportRef}
              >
                <div className="space-y-4">
                  {selectedMessages.length === 0 ? (
                    <div className="rounded-[24px] border border-dashed border-white/10 bg-white/3 px-4 py-6 text-sm text-stone-400">
                      {selectedSession
                        ? "No messages yet for this session."
                        : "Create a sandbox to start chatting."}
                    </div>
                  ) : (
                    selectedMessages.map((message) => {
                      const isCompactSystemMessage =
                        message.role === "system" && message.id !== latestSystemMessageId;

                      if (isCompactSystemMessage) {
                        return (
                          <div
                            className="border-l border-white/10 pl-3 text-xs leading-5 text-stone-500"
                            key={message.id}
                          >
                            <p className="whitespace-pre-wrap">{message.content}</p>
                          </div>
                        );
                      }

                      return (
                        <article
                          className={`max-w-[92%] rounded-[24px] px-4 py-3 shadow-[0_10px_30px_rgba(0,0,0,0.18)] ${
                            message.role === "user"
                              ? "ml-auto bg-amber-300 text-stone-950"
                              : message.kind === "error"
                                ? "bg-rose-500/16 text-rose-50 ring-1 ring-rose-500/20"
                                : message.role === "system"
                                  ? "bg-white/5 text-stone-300 ring-1 ring-white/10"
                                  : "bg-teal-400/14 text-stone-100 ring-1 ring-teal-300/18"
                          }`}
                          key={message.id}
                        >
                          <div className="mb-2 text-[11px] uppercase tracking-[0.2em] opacity-70">
                            {message.role}
                          </div>
                          <p className="whitespace-pre-wrap text-sm leading-6">
                            {message.content}
                          </p>
                        </article>
                      );
                    })
                  )}
                </div>
              </ScrollArea.Viewport>
              <ScrollArea.Scrollbar
                className="flex w-3 touch-none select-none border-l border-white/5 bg-white/[0.03] p-0.5"
                orientation="vertical"
              >
                <ScrollArea.Thumb className="relative flex-1 rounded-full bg-white/14 transition hover:bg-white/22" />
              </ScrollArea.Scrollbar>
              <ScrollArea.Corner className="bg-transparent" />
            </ScrollArea.Root>

            <div className="border-t border-white/10 px-5 py-4">
              {selectedSession?.terminatedAt ? (
                <p className="rounded-[20px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-stone-400">
                  This sandbox was terminated. Its transcript and last screenshot remain available below.
                </p>
              ) : (
                <div className="space-y-3">
                  <textarea
                    className="min-h-[120px] w-full rounded-[24px] border border-white/10 bg-white/5 px-4 py-4 text-sm text-stone-100 outline-none transition placeholder:text-stone-500 focus:border-amber-300/50 focus:bg-white/8"
                    disabled={composerDisabled}
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={
                      selectedSession?.runState === "pending"
                        ? "Wait for the sandbox to finish booting..."
                        : composerDisabled
                          ? "Wait for the current run to finish..."
                          : "Tell the agent what to do in this sandbox..."
                    }
                    value={composer}
                  />
                  <div className="flex justify-end">
                    <button
                      className="rounded-full bg-teal-300 px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-teal-300/60"
                      disabled={composerDisabled || composer.trim().length === 0}
                      onClick={() => void handleSubmitMessage()}
                      type="button"
                    >
                      Send
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div>
                <h2 className="text-lg font-medium text-stone-100">Live desktop</h2>
                <p className="text-sm text-stone-400">
                  {selectedSession
                    ? selectedSession.runState === "pending" &&
                      selectedSession.lastScreenshotRevision === 0
                      ? "Waiting for first frame"
                      : selectedSession.terminatedAt
                        ? `Archived capture ${selectedSession.lastScreenshotRevision}`
                        : "Streaming live from the sandbox"
                    : "No desktop available"}
                </p>
              </div>
              {canPopOutDesktop ? (
                <button
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-stone-200 transition hover:bg-white/10"
                  onClick={() => setIsDesktopOverlayOpen(true)}
                  type="button"
                >
                  Pop out
                </button>
              ) : null}
            </div>

            <div className="flex-1 overflow-hidden px-5 py-5">
              <RemoteDesktop
                className="h-full"
                displayPriority={0}
                interactiveEnabled={!isDesktopOverlayOpen}
                session={selectedSession}
                streamEnabled
              />
            </div>

            <div className="border-t border-white/10 px-5 py-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm uppercase tracking-[0.24em] text-stone-500">
                  Recent sessions
                </h3>
              </div>
              <ScrollArea.Root className="max-h-48">
                <ScrollArea.Viewport className="space-y-2">
                  {archivedSessions.length === 0 ? (
                    <p className="rounded-[20px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-stone-400">
                      No archived sessions yet.
                    </p>
                  ) : (
                    archivedSessions.map((session) => (
                      <div
                        className={`flex items-center gap-2 rounded-[20px] border px-3 py-2 transition ${
                          session.id === selectedSession?.id
                            ? "border-amber-300/40 bg-amber-300/10"
                            : "border-white/10 bg-white/4 hover:bg-white/8"
                        }`}
                        key={session.id}
                      >
                        <button
                          aria-label={`${session.title} archived`}
                          className="flex min-w-0 flex-1 items-center justify-between rounded-[16px] px-1 py-1 text-left text-sm text-stone-300"
                          onClick={() => setSelectedSessionId(session.id)}
                          type="button"
                        >
                          <span className={session.id === selectedSession?.id ? "text-amber-50" : ""}>
                            {session.title}
                          </span>
                          <span className="text-xs uppercase tracking-[0.2em] text-stone-500">
                            archived
                          </span>
                        </button>
                        <button
                          aria-label={`Delete ${session.title} permanently`}
                          className="rounded-full border border-rose-400/20 bg-rose-500/8 px-3 py-2 text-xs font-medium text-rose-100 transition hover:border-rose-400/40 hover:bg-rose-500/16"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDeleteArchivedSession(session.id);
                          }}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    ))
                  )}
                </ScrollArea.Viewport>
              </ScrollArea.Root>
            </div>
          </section>
        </div>
      </div>
      {isDesktopOverlayOpen && selectedSession ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-4 backdrop-blur-sm">
          <div className="flex h-[min(800px,calc(100vh-2rem))] w-[min(1200px,calc(100vw-2rem))] flex-col border border-white/10 bg-stone-950 shadow-[0_24px_90px_rgba(0,0,0,0.55)]">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <h2 className="text-base font-medium text-stone-100">
                  {selectedSession.title}
                </h2>
                <p className="text-sm text-stone-400">
                  Large live desktop view
                </p>
              </div>
              <button
                className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-stone-200 transition hover:bg-white/10"
                onClick={() => setIsDesktopOverlayOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 p-4">
              <RemoteDesktop
                className="h-full"
                displayPriority={10}
                interactiveEnabled
                session={selectedSession}
                streamEnabled
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function upsertSession(
  current: SessionSummary[],
  incoming: SessionSummary,
): SessionSummary[] {
  const found = current.some((session) => session.id === incoming.id);
  const next = found
    ? current.map((session) => (session.id === incoming.id ? incoming : session))
    : [incoming, ...current];
  return sortSessions(next);
}

function removeSession(current: SessionSummary[], sessionId: string): SessionSummary[] {
  return current.filter((session) => session.id !== sessionId);
}

function removeMessagesForSession(current: MessageMap, sessionId: string): MessageMap {
  const { [sessionId]: _removed, ...rest } = current;
  return rest;
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function preferredSessionId(sessions: SessionSummary[]): string | null {
  const active = sortSessions(sessions.filter((session) => session.terminatedAt === null))[0];
  if (active) {
    return active.id;
  }

  const archived = sortSessions(sessions.filter((session) => session.terminatedAt !== null))[0];
  return archived?.id ?? null;
}
