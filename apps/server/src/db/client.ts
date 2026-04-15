import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";

import { messagesTable, sessionsTable } from "./schema.js";

export interface DatabaseBundle {
  sqlite: BetterSqlite3.Database;
  db: BetterSQLite3Database<{
    sessionsTable: typeof sessionsTable;
    messagesTable: typeof messagesTable;
  }>;
  absolutePath: string;
}

export function createDatabase(dbPath: string): DatabaseBundle {
  const absolutePath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const sqlite = new Database(absolutePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'openai',
      provider_state TEXT,
      sandbox_id TEXT,
      sandbox_status TEXT NOT NULL,
      run_state TEXT NOT NULL,
      openai_last_response_id TEXT,
      last_screenshot_path TEXT,
      last_screenshot_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_created
      ON messages(session_id, created_at);
  `);

  ensureSessionsColumn(sqlite, "visitor_id", "TEXT NOT NULL DEFAULT '__legacy__'");
  ensureSessionsColumn(sqlite, "provider", "TEXT NOT NULL DEFAULT 'openai'");
  ensureSessionsColumn(sqlite, "provider_state", "TEXT");
  sqlite.exec(`
    UPDATE sessions
    SET provider_state = openai_last_response_id
    WHERE provider = 'openai'
      AND provider_state IS NULL
      AND openai_last_response_id IS NOT NULL;
  `);

  const db = drizzle(sqlite, {
    schema: {
      sessionsTable,
      messagesTable,
    },
  });

  return { sqlite, db, absolutePath };
}

function ensureSessionsColumn(
  sqlite: BetterSqlite3.Database,
  columnName: string,
  sqlDefinition: string,
): void {
  const columns = sqlite
    .prepare("PRAGMA table_info(sessions)")
    .all() as Array<{ name: string }>;

  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  sqlite.exec(`ALTER TABLE sessions ADD COLUMN ${columnName} ${sqlDefinition};`);
}
