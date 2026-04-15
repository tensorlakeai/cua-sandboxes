import {
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const sessionsTable = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  provider: text("provider").notNull().default("openai"),
  providerState: text("provider_state"),
  sandboxId: text("sandbox_id"),
  sandboxStatus: text("sandbox_status").notNull(),
  runState: text("run_state").notNull(),
  openaiLastResponseId: text("openai_last_response_id"),
  lastScreenshotPath: text("last_screenshot_path"),
  lastScreenshotRevision: integer("last_screenshot_revision").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  terminatedAt: text("terminated_at"),
});

export const messagesTable = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessionsTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});
