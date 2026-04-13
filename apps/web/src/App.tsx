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
  useState,
} from "react";

import {
  closeSession,
  createSession,
  listMessages,
  listSessions,
  refreshSession,
  sendMessage,
  stopSession,
} from "./api.js";

type MessageMap = Record<string, ChatMessage[]>;

const EVENT_TYPES = [
  "session.upsert",
  "session.terminated",
  "message.created",
  "screenshot.updated",
  "run.state",
  "error",
] as const;

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [messagesBySession, setMessagesBySession] = useState<MessageMap>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

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
    : (activeSessions[0]?.id ?? "");

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

  useEffect(() => {
    const source = new EventSource("/api/events");

    for (const eventType of EVENT_TYPES) {
      source.addEventListener(eventType, handleEvent as EventListener);
    }

    source.onerror = () => {
      setStatusMessage("Lost the live connection. Waiting to reconnect...");
    };

    return () => {
      source.close();
    };
  }, [handleEvent]);

  async function loadInitialState() {
    try {
      const response = await listSessions();
      setSessions(sortSessions(response.sessions));
      setSelectedSessionId(response.sessions[0]?.id ?? null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to load sessions");
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

  async function handleRefreshSession() {
    if (!selectedSession || selectedSession.terminatedAt) {
      return;
    }

    try {
      const response = await refreshSession(selectedSession.id);
      setSessions((current) => upsertSession(current, response.session));
      setStatusMessage(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to refresh screenshot");
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

  const screenshotUrl = selectedSession
    && selectedSession.lastScreenshotRevision > 0
    ? `/api/sessions/${selectedSession.id}/screenshot?rev=${selectedSession.lastScreenshotRevision}`
    : null;
  const selectedMessages = selectedSession
    ? (messagesBySession[selectedSession.id] ?? [])
    : [];
  const composerDisabled =
    !selectedSession ||
    selectedSession.terminatedAt !== null ||
    selectedSession.runState === "pending" ||
    selectedSession.runState === "running" ||
    selectedSession.runState === "stopping";

  return (
    <div className="min-h-screen px-4 py-4 text-stone-100 md:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1600px] flex-col rounded-[32px] border border-white/10 bg-stone-950/75 shadow-[0_24px_90px_rgba(0,0,0,0.45)] backdrop-blur">
        <header className="border-b border-white/10 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-amber-300/70">
                Tensorlake + OpenAI
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
                CUA Sandboxes
              </h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-stone-300">
                {activeSessions.length} active
              </span>
              <button
                className="rounded-full bg-amber-300 px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-amber-300/60"
                disabled={isCreating}
                onClick={() => void handleCreateSession()}
                type="button"
              >
                {isCreating ? "Starting..." : "+ New sandbox"}
              </button>
            </div>
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

        <div className="grid-shell flex-1">
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

            <ScrollArea.Root className="min-h-0 flex-1">
              <ScrollArea.Viewport className="h-full px-5 py-5">
                <div className="space-y-4">
                  {selectedMessages.length === 0 ? (
                    <div className="rounded-[24px] border border-dashed border-white/10 bg-white/3 px-4 py-6 text-sm text-stone-400">
                      {selectedSession
                        ? "No messages yet for this session."
                        : "Create a sandbox to start chatting."}
                    </div>
                  ) : (
                    selectedMessages.map((message) => (
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
                    ))
                  )}
                </div>
              </ScrollArea.Viewport>
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
                    placeholder={
                      selectedSession?.runState === "pending"
                        ? "Wait for the sandbox to finish booting..."
                        : composerDisabled
                          ? "Wait for the current run to finish..."
                          : "Tell the agent what to do in this sandbox..."
                    }
                    value={composer}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-stone-500">
                      One sandbox per tab. Runs stream back live through SSE.
                    </p>
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
                <h2 className="text-lg font-medium text-stone-100">Current screenshot</h2>
                <p className="text-sm text-stone-400">
                  {selectedSession
                    ? selectedSession.runState === "pending" &&
                      selectedSession.lastScreenshotRevision === 0
                      ? "Waiting for first screenshot"
                      : `Revision ${selectedSession.lastScreenshotRevision}`
                    : "No screenshot available"}
                </p>
              </div>
              {selectedSession &&
              selectedSession.terminatedAt === null &&
              selectedSession.runState !== "pending" ? (
                <button
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-stone-200 transition hover:bg-white/10"
                  onClick={() => void handleRefreshSession()}
                  type="button"
                >
                  Refresh
                </button>
              ) : null}
            </div>

            <div className="flex-1 overflow-hidden px-5 py-5">
              {screenshotUrl ? (
                <div className="h-full rounded-[28px] border border-white/10 bg-black/25 p-3">
                  <img
                    alt={selectedSession?.title ?? "Sandbox screenshot"}
                    className="h-full w-full rounded-[20px] object-contain"
                    src={screenshotUrl}
                  />
                </div>
              ) : selectedSession?.runState === "pending" ? (
                <div className="flex h-full flex-col items-center justify-center rounded-[28px] border border-dashed border-amber-300/20 bg-amber-300/6 px-6 text-center">
                  <p className="text-base font-medium text-amber-50">
                    Sandbox booting
                  </p>
                  <p className="mt-2 max-w-md text-sm text-amber-100/70">
                    Waiting for the desktop to become available. The app will keep polling until the first screenshot is ready.
                  </p>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center rounded-[28px] border border-dashed border-white/10 bg-white/3 px-6 text-center text-sm text-stone-400">
                  Create a sandbox to see its live desktop here.
                </div>
              )}
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
                      <button
                        className={`flex w-full items-center justify-between rounded-[20px] border px-4 py-3 text-left text-sm transition ${
                          session.id === selectedSession?.id
                            ? "border-amber-300/40 bg-amber-300/10 text-amber-50"
                            : "border-white/10 bg-white/4 text-stone-300 hover:bg-white/8"
                        }`}
                        key={session.id}
                        onClick={() => setSelectedSessionId(session.id)}
                        type="button"
                      >
                        <span>{session.title}</span>
                        <span className="text-xs uppercase tracking-[0.2em] text-stone-500">
                          archived
                        </span>
                      </button>
                    ))
                  )}
                </ScrollArea.Viewport>
              </ScrollArea.Root>
            </div>
          </section>
        </div>
      </div>
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

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}
