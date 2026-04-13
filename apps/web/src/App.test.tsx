import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ChatMessage,
  SessionSummary,
  SseEvent,
} from "@vnc-cua/contracts";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import App from "./App.js";

class MockEventSource {
  static instances: MockEventSource[] = [];

  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(event: SseEvent): void {
    const listeners = this.listeners.get(event.type);
    if (!listeners) {
      return;
    }

    const messageEvent = new MessageEvent(event.type, {
      data: JSON.stringify(event),
    });
    for (const listener of listeners) {
      listener(messageEvent);
    }
  }

  static latest(): MockEventSource {
    const instance = MockEventSource.instances.at(-1);
    if (!instance) {
      throw new Error("No EventSource instance was created");
    }
    return instance;
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}

interface ApiState {
  sessions: SessionSummary[];
  messagesBySession: Record<string, ChatMessage[]>;
  createQueue: SessionSummary[];
}

let timestampCounter = 0;

function nextIso(): string {
  timestampCounter += 1;
  return new Date(Date.UTC(2026, 3, 13, 12, 0, timestampCounter)).toISOString();
}

function makeSession(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "title">): SessionSummary {
  const createdAt = overrides.createdAt ?? "2026-04-13T12:00:00.000Z";
  return {
    id: overrides.id,
    title: overrides.title,
    sandboxId: overrides.sandboxId ?? `sbx-${overrides.id}`,
    sandboxStatus: overrides.sandboxStatus ?? "running",
    runState: overrides.runState ?? "ready",
    lastScreenshotRevision: overrides.lastScreenshotRevision ?? 1,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    terminatedAt: overrides.terminatedAt ?? null,
  };
}

function makeMessage(
  overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "sessionId" | "content">,
): ChatMessage {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId,
    role: overrides.role ?? "assistant",
    kind: overrides.kind ?? "text",
    content: overrides.content,
    createdAt: overrides.createdAt ?? nextIso(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function installFetchMock(state: ApiState) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === "/api/sessions" && method === "GET") {
      return jsonResponse({ sessions: state.sessions });
    }

    if (url === "/api/sessions" && method === "POST") {
      const session = state.createQueue.shift();
      if (!session) {
        return jsonResponse({ message: "No queued session" }, 500);
      }
      state.sessions = [session, ...state.sessions];
      return jsonResponse({ session }, 201);
    }

    const messagesMatch = url.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch && method === "GET") {
      return jsonResponse({
        messages: state.messagesBySession[messagesMatch[1] ?? ""] ?? [],
      });
    }

    const refreshMatch = url.match(/^\/api\/sessions\/([^/]+)\/refresh$/);
    if (refreshMatch && method === "POST") {
      const session = updateSession(state, refreshMatch[1] ?? "", (current) => ({
        ...current,
        lastScreenshotRevision: current.lastScreenshotRevision + 1,
        updatedAt: nextIso(),
      }));
      return jsonResponse({ session });
    }

    const stopMatch = url.match(/^\/api\/sessions\/([^/]+)\/stop$/);
    if (stopMatch && method === "POST") {
      const session = updateSession(state, stopMatch[1] ?? "", (current) => ({
        ...current,
        runState: "stopping",
        updatedAt: nextIso(),
      }));
      return jsonResponse({ session });
    }

    if (messagesMatch && method === "POST") {
      const sessionId = messagesMatch[1] ?? "";
      const session = updateSession(state, sessionId, (current) => ({
        ...current,
        runState: "running",
        updatedAt: nextIso(),
      }));
      return jsonResponse({ session });
    }

    const deleteMatch = url.match(/^\/api\/sessions\/([^/?]+)$/);
    if (deleteMatch && method === "DELETE") {
      const session = updateSession(state, deleteMatch[1] ?? "", (current) => ({
        ...current,
        sandboxStatus: "terminated",
        runState: "terminated",
        terminatedAt: nextIso(),
        updatedAt: nextIso(),
      }));
      return jsonResponse({ session });
    }

    return jsonResponse({ message: `Unhandled ${method} ${url}` }, 500);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function updateSession(
  state: ApiState,
  sessionId: string,
  updater: (session: SessionSummary) => SessionSummary,
): SessionSummary {
  let updated: SessionSummary | null = null;
  state.sessions = state.sessions.map((session) => {
    if (session.id !== sessionId) {
      return session;
    }
    updated = updater(session);
    return updated;
  });

  if (!updated) {
    throw new Error(`Session ${sessionId} was not found`);
  }

  return updated;
}

describe("App", () => {
  beforeEach(() => {
    timestampCounter = 0;
    MockEventSource.reset();
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    MockEventSource.reset();
  });

  it("creates new sandboxes and archives closed tabs immediately", async () => {
    const sandbox1 = makeSession({
      id: "session-1",
      title: "Sandbox 1",
      updatedAt: "2026-04-13T12:00:10.000Z",
    });
    const sandbox2 = makeSession({
      id: "session-2",
      title: "Sandbox 2",
      updatedAt: "2026-04-13T12:00:20.000Z",
    });

    installFetchMock({
      sessions: [sandbox1],
      messagesBySession: {
        [sandbox1.id]: [makeMessage({ id: "m1", sessionId: sandbox1.id, content: "Ready to go." })],
      },
      createQueue: [sandbox2],
    });

    render(<App />);

    await screen.findByRole("tab", { name: "Sandbox 1" });

    fireEvent.click(screen.getByRole("button", { name: "+ New sandbox" }));

    await screen.findByRole("tab", { name: "Sandbox 2" });
    expect(screen.getByText("2 active")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close Sandbox 2" }));

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "Sandbox 2" })).not.toBeInTheDocument();
    });

    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sandbox 2/i })).toBeInTheDocument();
  });

  it("applies SSE updates to the right session and loads archived transcripts", async () => {
    const sandbox1 = makeSession({
      id: "session-1",
      title: "Sandbox 1",
      updatedAt: "2026-04-13T12:00:30.000Z",
    });
    const sandbox2 = makeSession({
      id: "session-2",
      title: "Sandbox 2",
      updatedAt: "2026-04-13T12:00:20.000Z",
    });
    const archived = makeSession({
      id: "session-3",
      title: "Old Session",
      sandboxId: null,
      sandboxStatus: "terminated",
      runState: "terminated",
      terminatedAt: "2026-04-13T11:59:00.000Z",
      updatedAt: "2026-04-13T12:00:00.000Z",
    });

    installFetchMock({
      sessions: [sandbox1, sandbox2, archived],
      messagesBySession: {
        [sandbox1.id]: [makeMessage({ id: "m1", sessionId: sandbox1.id, content: "Active transcript" })],
        [archived.id]: [makeMessage({ id: "m2", sessionId: archived.id, content: "Archived summary" })],
      },
      createQueue: [],
    });

    render(<App />);

    await screen.findByRole("tab", { name: "Sandbox 1" });

    const eventSource = MockEventSource.latest();
    await act(async () => {
      eventSource.emit({
        type: "message.created",
        message: makeMessage({
          id: "m-live",
          sessionId: sandbox2.id,
          content: "Live result from sandbox two",
        }),
      });
      eventSource.emit({
        type: "screenshot.updated",
        sessionId: sandbox2.id,
        revision: 4,
        updatedAt: "2026-04-13T12:01:00.000Z",
      });
      eventSource.emit({
        type: "run.state",
        sessionId: sandbox2.id,
        runState: "running",
      });
    });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Sandbox 2" }), {
      button: 0,
      ctrlKey: false,
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sandbox 2" })).toBeInTheDocument();
    });
    await screen.findByText("Live result from sandbox two");
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("img", { name: "Sandbox 2" })).toHaveAttribute(
      "src",
      `/api/sessions/${sandbox2.id}/screenshot?rev=4`,
    );

    fireEvent.click(screen.getByRole("button", { name: /Old Session/i }));

    await screen.findByText("Archived summary");
    expect(
      screen.getByText(
        "This sandbox was terminated. Its transcript and last screenshot remain available below.",
      ),
    ).toBeInTheDocument();
  });
});
