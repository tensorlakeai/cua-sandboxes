import {
  createSessionResponseSchema,
  deleteSessionResponseSchema,
  listMessagesResponseSchema,
  listSessionsResponseSchema,
  postMessageRequestSchema,
  sessionMutationResponseSchema,
  type DeleteSessionResponse,
  type ListMessagesResponse,
  type ListSessionsResponse,
  type SessionMutationResponse,
} from "@vnc-cua/contracts";

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  parser: (value: unknown) => T,
): Promise<T> {
  const response = await fetch(input, init);
  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      typeof json?.message === "string"
        ? json.message
        : `Request failed with ${response.status}`,
    );
  }

  return parser(json);
}

export function listSessions(): Promise<ListSessionsResponse> {
  return requestJson(
    "/api/sessions",
    { method: "GET" },
    (value) => listSessionsResponseSchema.parse(value),
  );
}

export function listMessages(sessionId: string): Promise<ListMessagesResponse> {
  return requestJson(
    `/api/sessions/${sessionId}/messages`,
    { method: "GET" },
    (value) => listMessagesResponseSchema.parse(value),
  );
}

export function createSession() {
  return requestJson(
    "/api/sessions",
    { method: "POST" },
    (value) => createSessionResponseSchema.parse(value),
  );
}

export function sendMessage(sessionId: string, content: string): Promise<SessionMutationResponse> {
  const body = postMessageRequestSchema.parse({ content });
  return requestJson(
    `/api/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    (value) => sessionMutationResponseSchema.parse(value),
  );
}

export function refreshSession(sessionId: string): Promise<SessionMutationResponse> {
  return requestJson(
    `/api/sessions/${sessionId}/refresh`,
    { method: "POST" },
    (value) => sessionMutationResponseSchema.parse(value),
  );
}

export function stopSession(sessionId: string): Promise<SessionMutationResponse> {
  return requestJson(
    `/api/sessions/${sessionId}/stop`,
    { method: "POST" },
    (value) => sessionMutationResponseSchema.parse(value),
  );
}

export function closeSession(sessionId: string): Promise<SessionMutationResponse> {
  return requestJson(
    `/api/sessions/${sessionId}`,
    { method: "DELETE" },
    (value) => sessionMutationResponseSchema.parse(value),
  );
}

export function deleteArchivedSession(sessionId: string): Promise<DeleteSessionResponse> {
  return requestJson(
    `/api/sessions/${sessionId}/permanent`,
    { method: "DELETE" },
    (value) => deleteSessionResponseSchema.parse(value),
  );
}
