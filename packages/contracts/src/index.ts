import { z } from "zod";

export const sessionRunStateSchema = z.enum([
  "pending",
  "ready",
  "running",
  "stopping",
  "terminated",
  "error",
]);

export const messageRoleSchema = z.enum(["system", "user", "assistant"]);
export const messageKindSchema = z.enum(["text", "status", "error"]);

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  sandboxId: z.string().nullable(),
  sandboxStatus: z.string(),
  runState: sessionRunStateSchema,
  lastScreenshotRevision: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  terminatedAt: z.string().nullable(),
});

export const messageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: messageRoleSchema,
  kind: messageKindSchema,
  content: z.string(),
  createdAt: z.string(),
});

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
});

export const listMessagesResponseSchema = z.object({
  messages: z.array(messageSchema),
});

export const createSessionResponseSchema = z.object({
  session: sessionSummarySchema,
});

export const postMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
});

export const sessionMutationResponseSchema = z.object({
  session: sessionSummarySchema,
});

export const deleteSessionResponseSchema = z.object({
  sessionId: z.string(),
});

export const eventSessionUpsertSchema = z.object({
  type: z.literal("session.upsert"),
  session: sessionSummarySchema,
});

export const eventSessionTerminatedSchema = z.object({
  type: z.literal("session.terminated"),
  sessionId: z.string(),
});

export const eventSessionDeletedSchema = z.object({
  type: z.literal("session.deleted"),
  sessionId: z.string(),
});

export const eventMessageCreatedSchema = z.object({
  type: z.literal("message.created"),
  message: messageSchema,
});

export const eventScreenshotUpdatedSchema = z.object({
  type: z.literal("screenshot.updated"),
  sessionId: z.string(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export const eventRunStateSchema = z.object({
  type: z.literal("run.state"),
  sessionId: z.string(),
  runState: sessionRunStateSchema,
});

export const eventErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  sessionId: z.string().nullable().optional(),
});

export const sseEventSchema = z.discriminatedUnion("type", [
  eventSessionUpsertSchema,
  eventSessionTerminatedSchema,
  eventSessionDeletedSchema,
  eventMessageCreatedSchema,
  eventScreenshotUpdatedSchema,
  eventRunStateSchema,
  eventErrorSchema,
]);

export type SessionRunState = z.infer<typeof sessionRunStateSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;
export type MessageKind = z.infer<typeof messageKindSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;
export type ListMessagesResponse = z.infer<typeof listMessagesResponseSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;
export type SessionMutationResponse = z.infer<
  typeof sessionMutationResponseSchema
>;
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>;
export type SseEvent = z.infer<typeof sseEventSchema>;
