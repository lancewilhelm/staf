import { Database } from "bun:sqlite";
import type {
  Activity,
  Message,
  MessageRole,
  MessageStatus,
  ThreadStatus,
  ThreadSummary,
} from "@staf/protocol";

const SCHEMA_VERSION = 3;

interface ThreadRow {
  id: string;
  title: string;
  agent_id: string;
  harness: string;
  model: string | null;
  effort: string | null;
  fast: number;
  session_id: string | null;
  status: ThreadStatus;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: MessageRole;
  text: string;
  activities: string;
  status: MessageStatus;
  error: string | null;
  harness: string | null;
  model: string | null;
  created_at: number;
  completed_at: number | null;
}

/** A harness session that a thread has used. A thread gets a new one when its harness changes. */
export interface HarnessSession {
  harness: string;
  sessionId: string;
  threadId: string;
}

export interface StoredThread extends ThreadSummary {
  /** The harness's own session ID, used to resume the conversation. */
  sessionId: string | null;
}

export interface MessagePatch {
  text?: string;
  activities?: Activity[];
  status?: MessageStatus;
  error?: string | null;
  completedAt?: number | null;
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const { user_version: version } = this.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version >= SCHEMA_VERSION) return;
    if (version < 1) this.createV1();
    if (version < 2) this.migrateToV2();
    if (version < 3) this.migrateToV3();
  }

  private migrateToV3(): void {
    this.db.transaction(() => {
      this.db.run("ALTER TABLE threads ADD COLUMN effort TEXT");
      this.db.run("ALTER TABLE threads ADD COLUMN fast INTEGER NOT NULL DEFAULT 0");
      this.db.run("PRAGMA user_version = 3");
    })();
  }

  private migrateToV2(): void {
    this.db.transaction(() => {
      this.db.run("ALTER TABLE threads ADD COLUMN model TEXT");
      this.db.run("ALTER TABLE messages ADD COLUMN harness TEXT");
      this.db.run("ALTER TABLE messages ADD COLUMN model TEXT");
      this.db.run(`
        CREATE TABLE harness_sessions (
          harness TEXT NOT NULL,
          session_id TEXT NOT NULL,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (harness, session_id)
        )`);
      this.db.run("CREATE INDEX harness_sessions_by_thread ON harness_sessions(thread_id)");
      this.db.run(`
        INSERT INTO harness_sessions (harness, session_id, thread_id, created_at)
        SELECT harness, session_id, id, created_at FROM threads WHERE session_id IS NOT NULL`);
      // Answers written before version 2 came from the thread's only harness.
      this.db.run(`
        UPDATE messages SET harness = (SELECT harness FROM threads WHERE threads.id = messages.thread_id)
        WHERE role = 'assistant'`);
      this.db.run("PRAGMA user_version = 2");
    })();
  }

  private createV1(): void {
    this.db.transaction(() => {
      this.db.run(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          harness TEXT NOT NULL,
          session_id TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
      this.db.run(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          activities TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER
        )`);
      this.db.run("CREATE INDEX messages_by_thread ON messages(thread_id, created_at)");
      this.db.run("PRAGMA user_version = 1");
    })();
  }

  /**
   * Marks work that a previous process left unfinished. Call this once at startup,
   * before any new turn runs.
   */
  recoverInterrupted(now = Date.now()): number {
    const changed = this.db
      .query(
        `UPDATE messages SET status = 'interrupted', completed_at = $now,
           error = COALESCE(error, 'Staf restarted before this answer finished.')
         WHERE status = 'streaming'`,
      )
      .run({ now });
    this.db.query("UPDATE threads SET status = 'idle' WHERE status = 'running'").run();
    return changed.changes;
  }

  createThread(input: {
    title: string;
    agentId: string;
    harness: string;
    model: string | null;
    effort: string | null;
    fast: boolean;
  }): StoredThread {
    const now = Date.now();
    const thread: StoredThread = {
      id: crypto.randomUUID(),
      title: input.title,
      agentId: input.agentId,
      harness: input.harness,
      model: input.model,
      effort: input.effort,
      fast: input.fast,
      sessionId: null,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO threads (id, title, agent_id, harness, model, effort, fast, session_id, status, created_at, updated_at)
         VALUES ($id, $title, $agentId, $harness, $model, $effort, $fast, NULL, $status, $createdAt, $updatedAt)`,
      )
      .run({
        id: thread.id,
        title: thread.title,
        agentId: thread.agentId,
        harness: thread.harness,
        model: thread.model,
        effort: thread.effort,
        fast: thread.fast ? 1 : 0,
        status: thread.status,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      });
    return thread;
  }

  listThreads(): StoredThread[] {
    const rows = this.db
      .query("SELECT * FROM threads ORDER BY updated_at DESC")
      .all() as ThreadRow[];
    return rows.map(toThread);
  }

  getThread(id: string): StoredThread | null {
    const row = this.db.query("SELECT * FROM threads WHERE id = $id").get({ id }) as
      | ThreadRow
      | null;
    return row ? toThread(row) : null;
  }

  updateThread(
    id: string,
    patch: {
      title?: string;
      harness?: string;
      model?: string | null;
      effort?: string | null;
      fast?: boolean;
      sessionId?: string | null;
      status?: ThreadStatus;
      touch?: boolean;
    },
  ): StoredThread | null {
    const current = this.getThread(id);
    if (!current) return null;
    const next: StoredThread = {
      ...current,
      title: patch.title ?? current.title,
      harness: patch.harness ?? current.harness,
      model: patch.model === undefined ? current.model : patch.model,
      effort: patch.effort === undefined ? current.effort : patch.effort,
      fast: patch.fast ?? current.fast,
      sessionId: patch.sessionId === undefined ? current.sessionId : patch.sessionId,
      status: patch.status ?? current.status,
      updatedAt: patch.touch ? Date.now() : current.updatedAt,
    };
    this.db
      .query(
        `UPDATE threads SET title = $title, harness = $harness, model = $model, effort = $effort, fast = $fast,
           session_id = $sessionId, status = $status, updated_at = $updatedAt WHERE id = $id`,
      )
      .run({
        id,
        title: next.title,
        harness: next.harness,
        model: next.model,
        effort: next.effort,
        fast: next.fast ? 1 : 0,
        sessionId: next.sessionId,
        status: next.status,
        updatedAt: next.updatedAt,
      });
    return next;
  }

  /** Records a harness session that a thread started. */
  addSession(input: HarnessSession): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO harness_sessions (harness, session_id, thread_id, created_at)
         VALUES ($harness, $sessionId, $threadId, $createdAt)`,
      )
      .run({ ...input, createdAt: Date.now() });
  }

  listSessions(threadId: string): HarnessSession[] {
    return (
      this.db
        .query("SELECT harness, session_id, thread_id FROM harness_sessions WHERE thread_id = $threadId ORDER BY created_at")
        .all({ threadId }) as Array<{ harness: string; session_id: string; thread_id: string }>
    ).map((row) => ({ harness: row.harness, sessionId: row.session_id, threadId: row.thread_id }));
  }

  listThreadsForAgent(agentId: string): StoredThread[] {
    return (this.db.query("SELECT * FROM threads WHERE agent_id = $agentId").all({ agentId }) as ThreadRow[]).map(toThread);
  }

  deleteThread(id: string): boolean {
    return this.db.query("DELETE FROM threads WHERE id = $id").run({ id }).changes > 0;
  }

  addMessage(input: {
    threadId: string;
    role: MessageRole;
    text: string;
    status: MessageStatus;
    harness?: string;
    model?: string | null;
  }): Message {
    const message: Message = {
      id: crypto.randomUUID(),
      threadId: input.threadId,
      role: input.role,
      text: input.text,
      activities: [],
      status: input.status,
      ...(input.harness ? { harness: input.harness, model: input.model ?? null } : {}),
      createdAt: Date.now(),
    };
    if (message.status !== "streaming") message.completedAt = message.createdAt;
    this.db
      .query(
        `INSERT INTO messages (id, thread_id, role, text, activities, status, error, harness, model, created_at, completed_at)
         VALUES ($id, $threadId, $role, $text, '[]', $status, NULL, $harness, $model, $createdAt, $completedAt)`,
      )
      .run({
        id: message.id,
        threadId: message.threadId,
        role: message.role,
        text: message.text,
        status: message.status,
        harness: message.harness ?? null,
        model: message.model ?? null,
        createdAt: message.createdAt,
        completedAt: message.completedAt ?? null,
      });
    return message;
  }

  updateMessage(id: string, patch: MessagePatch): Message | null {
    const current = this.getMessage(id);
    if (!current) return null;
    const next: Message = {
      ...current,
      text: patch.text ?? current.text,
      activities: patch.activities ?? current.activities,
      status: patch.status ?? current.status,
    };
    const error = patch.error === undefined ? current.error : (patch.error ?? undefined);
    const completedAt =
      patch.completedAt === undefined ? current.completedAt : (patch.completedAt ?? undefined);
    if (error === undefined) delete next.error;
    else next.error = error;
    if (completedAt === undefined) delete next.completedAt;
    else next.completedAt = completedAt;
    this.db
      .query(
        `UPDATE messages SET text = $text, activities = $activities, status = $status,
           error = $error, completed_at = $completedAt WHERE id = $id`,
      )
      .run({
        id,
        text: next.text,
        activities: JSON.stringify(next.activities),
        status: next.status,
        error: next.error ?? null,
        completedAt: next.completedAt ?? null,
      });
    return next;
  }

  getMessage(id: string): Message | null {
    const row = this.db.query("SELECT * FROM messages WHERE id = $id").get({ id }) as
      | MessageRow
      | null;
    return row ? toMessage(row) : null;
  }

  listMessages(threadId: string): Message[] {
    const rows = this.db
      .query("SELECT * FROM messages WHERE thread_id = $threadId ORDER BY created_at, rowid")
      .all({ threadId }) as MessageRow[];
    return rows.map(toMessage);
  }
}

function toThread(row: ThreadRow): StoredThread {
  return {
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    harness: row.harness,
    model: row.model,
    effort: row.effort,
    fast: row.fast === 1,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  const message: Message = {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    text: row.text,
    activities: JSON.parse(row.activities) as Activity[],
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.harness !== null) {
    message.harness = row.harness;
    message.model = row.model;
  }
  if (row.error !== null) message.error = row.error;
  if (row.completed_at !== null) message.completedAt = row.completed_at;
  return message;
}

/** The public view of a thread, without harness-internal fields. */
export function publicThread(thread: StoredThread): ThreadSummary {
  const { sessionId: _sessionId, ...summary } = thread;
  return summary;
}
