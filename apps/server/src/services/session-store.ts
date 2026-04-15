import { nanoid } from "nanoid";

import {
  messageSchema,
  sessionSummarySchema,
  type ChatMessage,
  type MessageKind,
  type MessageRole,
  type SessionRunState,
  type SessionSummary,
} from "@vnc-cua/contracts";
import { asc, desc, eq, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { nowIso } from "../lib/time.js";
import { messagesTable, sessionsTable } from "../db/schema.js";

type SessionRow = typeof sessionsTable.$inferSelect;
type MessageRow = typeof messagesTable.$inferSelect;

export interface SessionRecord extends SessionRow {}
export type SessionProvider = "openai" | "gemini";

export interface SessionCreateInput {
  id?: string;
  title: string;
  provider: SessionProvider;
  providerState?: string | null;
  sandboxId: string;
  sandboxStatus: string;
  runState: SessionRunState;
  openaiLastResponseId?: string | null;
  lastScreenshotPath?: string | null;
  lastScreenshotRevision?: number;
}

export interface SessionUpdateInput {
  title?: string;
  provider?: SessionProvider;
  providerState?: string | null;
  sandboxId?: string | null;
  sandboxStatus?: string;
  runState?: SessionRunState;
  openaiLastResponseId?: string | null;
  lastScreenshotPath?: string | null;
  lastScreenshotRevision?: number;
  terminatedAt?: string | null;
}

export class SessionStore {
  constructor(
    private readonly db: BetterSQLite3Database<{
      sessionsTable: typeof sessionsTable;
      messagesTable: typeof messagesTable;
    }>,
  ) {}

  listSessionRecords(): SessionRecord[] {
    return this.db.select().from(sessionsTable).orderBy(desc(sessionsTable.updatedAt)).all();
  }

  listActiveSessionRecords(): SessionRecord[] {
    return this.db
      .select()
      .from(sessionsTable)
      .where(isNull(sessionsTable.terminatedAt))
      .orderBy(desc(sessionsTable.updatedAt))
      .all();
  }

  getSessionRecord(sessionId: string): SessionRecord | null {
    return (
      this.db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.id, sessionId))
        .get() ?? null
    );
  }

  requireSessionRecord(sessionId: string): SessionRecord {
    const session = this.getSessionRecord(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} was not found`);
    }
    return session;
  }

  createSession(input: SessionCreateInput): SessionRecord {
    const createdAt = nowIso();
    const id = input.id ?? nanoid();

    this.db.insert(sessionsTable).values({
      id,
      title: input.title,
      provider: input.provider,
      providerState: input.providerState ?? input.openaiLastResponseId ?? null,
      sandboxId: input.sandboxId,
      sandboxStatus: input.sandboxStatus,
      runState: input.runState,
      openaiLastResponseId: input.openaiLastResponseId ?? null,
      lastScreenshotPath: input.lastScreenshotPath ?? null,
      lastScreenshotRevision: input.lastScreenshotRevision ?? 0,
      createdAt,
      updatedAt: createdAt,
      terminatedAt: null,
    }).run();

    return this.requireSessionRecord(id);
  }

  updateSession(sessionId: string, input: SessionUpdateInput): SessionRecord {
    this.db
      .update(sessionsTable)
      .set({
        ...input,
        updatedAt: nowIso(),
      })
      .where(eq(sessionsTable.id, sessionId))
      .run();

    return this.requireSessionRecord(sessionId);
  }

  terminateSession(sessionId: string, sandboxStatus = "terminated"): SessionRecord {
    const terminatedAt = nowIso();
    return this.updateSession(sessionId, {
      sandboxStatus,
      runState: "terminated",
      terminatedAt,
    });
  }

  deleteSession(sessionId: string): SessionRecord {
    const record = this.requireSessionRecord(sessionId);
    this.db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId)).run();
    return record;
  }

  createMessage(input: {
    sessionId: string;
    role: MessageRole;
    kind: MessageKind;
    content: string;
  }): ChatMessage {
    const id = nanoid();
    const createdAt = nowIso();

    this.db.insert(messagesTable).values({
      id,
      sessionId: input.sessionId,
      role: input.role,
      kind: input.kind,
      content: input.content,
      createdAt,
    }).run();

    return this.requireMessage(id);
  }

  listMessages(sessionId: string): ChatMessage[] {
    return this.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, sessionId))
      .orderBy(asc(messagesTable.createdAt))
      .all()
      .map(toMessage);
  }

  private requireMessage(messageId: string): ChatMessage {
    const row =
      this.db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.id, messageId))
        .get() ?? null;

    if (!row) {
      throw new Error(`Message ${messageId} was not found`);
    }

    return toMessage(row);
  }
}

export function toSessionSummary(row: SessionRecord): SessionSummary {
  return sessionSummarySchema.parse({
    id: row.id,
    title: row.title,
    sandboxId: row.sandboxId ?? null,
    sandboxStatus: row.sandboxStatus,
    runState: row.runState,
    lastScreenshotRevision: row.lastScreenshotRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    terminatedAt: row.terminatedAt ?? null,
  });
}

function toMessage(row: MessageRow): ChatMessage {
  return messageSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    kind: row.kind,
    content: row.content,
    createdAt: row.createdAt,
  });
}
