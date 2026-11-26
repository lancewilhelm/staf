import { Database } from "bun:sqlite";
import {
  DEFAULT_PREFERENCES,
  isHeroFont,
  isSidebarMode,
  isThemePreference,
  type Activity,
  type Attachment,
  type MemoryBlock,
  type MemoryEntry,
  type MemoryProposalAction,
  type MemorySource,
  type MemoryStatus,
  type Message,
  type MessageRole,
  type MessageStats,
  type MessageStatus,
  type ScheduledTask,
  type ScheduledTaskRunStatus,
  type TaskSchedule,
  type ThreadSource,
  type ThreadStatus,
  type ThreadSummary,
  type UpdatePreferencesRequest,
  type UserPreferences,
} from "@staf/protocol";

const SCHEMA_VERSION = 9;
const DEFAULT_PERSON_ID = "default";

/** Full per-message metadata stored in SQLite, including raw provider fields not exposed to clients. */
export interface StoredMessageMeta extends MessageStats {
  providerMeta?: Record<string, unknown>;
}

interface ThreadRow {
  id: string;
  title: string;
  agent_id: string;
  harness: string;
  model: string | null;
  effort: string | null;
  fast: number;
  source: ThreadSource;
  task_id: string | null;
  settled_at: number | null;
  session_id: string | null;
  memory_snapshot: string | null;
  status: ThreadStatus;
  running_since: number | null;
  created_at: number;
  updated_at: number;
  pending_proposals?: number;
}

interface MemoryRow {
  id: string;
  agent_id: string;
  block: MemoryBlock;
  text: string;
  status: MemoryStatus;
  proposed_action: MemoryProposalAction | null;
  target_id: string | null;
  source: string;
  thread_id: string | null;
  message_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ScheduledTaskRow {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: number;
  harness: string | null;
  model: string | null;
  effort: string | null;
  fast: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_thread_id: string | null;
  last_run_status: ScheduledTaskRunStatus | null;
  last_run_error: string | null;
  created_at: number;
  updated_at: number;
}

interface AttachmentRow {
  id: string;
  thread_id: string;
  message_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  created_at: number;
}

export interface StoredAttachment extends Attachment {
  /** Path relative to the host's attachments folder. */
  storagePath: string;
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
  meta: string | null;
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
  /** Frozen memory block copied into instructions when the thread started. */
  memorySnapshot: string | null;
}

/** One full-text search hit across an agent's past messages. */
export interface ConversationSearchHit {
  threadId: string;
  threadTitle: string;
  threadSource: ThreadSource;
  messageId: string;
  role: MessageRole;
  snippet: string;
  createdAt: number;
}

export interface MessagePatch {
  text?: string;
  activities?: Activity[];
  status?: MessageStatus;
  error?: string | null;
  meta?: StoredMessageMeta | null;
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
    if (version < 4) this.migrateToV4();
    if (version < 5) this.migrateToV5();
    if (version < 6) this.migrateToV6();
    if (version < 7) this.migrateToV7();
    if (version < 8) this.migrateToV8();
    if (version < 9) this.migrateToV9();
  }

  private migrateToV9(): void {
    this.db.transaction(() => {
      this.db.run("ALTER TABLE threads ADD COLUMN memory_snapshot TEXT");
      this.db.run(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          block TEXT NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL,
          proposed_action TEXT,
          target_id TEXT,
          source TEXT NOT NULL,
          thread_id TEXT,
          message_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
      this.db.run("CREATE INDEX memories_by_agent ON memories(agent_id, status, block, created_at)");
      this.db.run("CREATE INDEX memories_by_thread ON memories(thread_id, status, created_at)");
      this.db.run("PRAGMA user_version = 9");
    })();
  }

  private migrateToV8(): void {
    this.db.transaction(() => {
      this.db.run(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          text,
          content='messages',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        )`);
      this.db.run(`
        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END`);
      this.db.run(`
        CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        END`);
      this.db.run(`
        CREATE TRIGGER messages_fts_update AFTER UPDATE OF text ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
          INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END`);
      this.db.run("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
      this.db.run("PRAGMA user_version = 8");
    })();
  }

  private migrateToV7(): void {
    this.db.transaction(() => {
      this.db.run("ALTER TABLE threads ADD COLUMN running_since INTEGER");
      this.db.run("ALTER TABLE messages ADD COLUMN meta TEXT");
      this.db.run("PRAGMA user_version = 7");
    })();
  }

  private migrateToV6(): void {
    this.db.transaction(() => {
      this.db.run("ALTER TABLE threads ADD COLUMN task_id TEXT");
      this.db.run(`
        CREATE TABLE scheduled_tasks (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          harness TEXT,
          model TEXT,
          effort TEXT,
          fast INTEGER NOT NULL DEFAULT 0,
          next_run_at INTEGER,
          last_run_at INTEGER,
          last_run_thread_id TEXT,
          last_run_status TEXT,
          last_run_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
      this.db.run("CREATE INDEX scheduled_tasks_by_agent ON scheduled_tasks(agent_id, created_at)");
      this.db.run("CREATE INDEX scheduled_tasks_next_run ON scheduled_tasks(enabled, next_run_at)");
      this.db.run("PRAGMA user_version = 6");
    })();
  }

  private migrateToV5(): void {
    this.db.transaction(() => {
      this.db.run("ALTER TABLE threads ADD COLUMN source TEXT NOT NULL DEFAULT 'chat'");
      this.db.run("ALTER TABLE threads ADD COLUMN settled_at INTEGER");
      this.db.run(`
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          storage_path TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`);
      this.db.run("CREATE INDEX attachments_by_message ON attachments(message_id, created_at)");
      this.db.run("CREATE INDEX attachments_by_thread ON attachments(thread_id)");
      this.db.run("PRAGMA user_version = 5");
    })();
  }

  private migrateToV4(): void {
    this.db.transaction(() => {
      this.db.run(`
        CREATE TABLE preferences (
          person_id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
      this.db.run("PRAGMA user_version = 4");
    })();
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
    this.db.query("UPDATE threads SET status = 'idle', running_since = NULL WHERE status = 'running'").run();
    this.db
      .query(
        `UPDATE scheduled_tasks SET last_run_status = 'interrupted',
           last_run_error = COALESCE(last_run_error, 'Staf restarted before this run finished.')
         WHERE last_run_status = 'running'`,
      )
      .run();
    return changed.changes;
  }

  createThread(input: {
    title: string;
    agentId: string;
    harness: string;
    model: string | null;
    effort: string | null;
    fast: boolean;
    source?: ThreadSource;
    taskId?: string | null;
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
      source: input.source ?? "chat",
      taskId: input.taskId ?? null,
      settledAt: null,
      pendingProposals: 0,
      sessionId: null,
      memorySnapshot: null,
      status: "idle",
      runningSince: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO threads (id, title, agent_id, harness, model, effort, fast, source, task_id, settled_at, session_id, memory_snapshot, status, running_since, created_at, updated_at)
         VALUES ($id, $title, $agentId, $harness, $model, $effort, $fast, $source, $taskId, NULL, NULL, NULL, $status, NULL, $createdAt, $updatedAt)`,
      )
      .run({
        id: thread.id,
        title: thread.title,
        agentId: thread.agentId,
        harness: thread.harness,
        model: thread.model,
        effort: thread.effort,
        fast: thread.fast ? 1 : 0,
        source: thread.source,
        taskId: thread.taskId,
        status: thread.status,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      });
    return thread;
  }

  listThreads(): StoredThread[] {
    const rows = this.db
      .query(
        `SELECT t.*,
           (SELECT COUNT(*) FROM memories m WHERE m.thread_id = t.id AND m.status = 'proposed') AS pending_proposals
         FROM threads t
         ORDER BY t.updated_at DESC`,
      )
      .all() as ThreadRow[];
    return rows.map(toThread);
  }

  getThread(id: string): StoredThread | null {
    const row = this.db
      .query(
        `SELECT t.*,
           (SELECT COUNT(*) FROM memories m WHERE m.thread_id = t.id AND m.status = 'proposed') AS pending_proposals
         FROM threads t
         WHERE t.id = $id`,
      )
      .get({ id }) as ThreadRow | null;
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
      settledAt?: number | null;
      sessionId?: string | null;
      memorySnapshot?: string | null;
      status?: ThreadStatus;
      runningSince?: number | null;
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
      settledAt: patch.settledAt === undefined ? current.settledAt : patch.settledAt,
      sessionId: patch.sessionId === undefined ? current.sessionId : patch.sessionId,
      memorySnapshot: patch.memorySnapshot === undefined ? current.memorySnapshot : patch.memorySnapshot,
      status: patch.status ?? current.status,
      runningSince: patch.runningSince === undefined ? current.runningSince : patch.runningSince,
      updatedAt: patch.touch ? Date.now() : current.updatedAt,
    };
    this.db
      .query(
        `UPDATE threads SET title = $title, harness = $harness, model = $model, effort = $effort, fast = $fast,
           settled_at = $settledAt, session_id = $sessionId, memory_snapshot = $memorySnapshot,
           status = $status, running_since = $runningSince, updated_at = $updatedAt WHERE id = $id`,
      )
      .run({
        id,
        title: next.title,
        harness: next.harness,
        model: next.model,
        effort: next.effort,
        fast: next.fast ? 1 : 0,
        settledAt: next.settledAt,
        sessionId: next.sessionId,
        memorySnapshot: next.memorySnapshot,
        status: next.status,
        runningSince: next.runningSince,
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
    this.db
      .query("UPDATE scheduled_tasks SET last_run_thread_id = NULL WHERE last_run_thread_id = $id")
      .run({ id });
    this.db
      .query("DELETE FROM memories WHERE thread_id = $id AND status = 'proposed'")
      .run({ id });
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
      attachments: [],
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
    const currentMeta = patch.meta === undefined ? this.getMessageMeta(id) : patch.meta;
    if (currentMeta) next.stats = publicMessageStats(currentMeta);
    else delete next.stats;
    this.db
      .query(
        `UPDATE messages SET text = $text, activities = $activities, status = $status,
           error = $error, meta = $meta, completed_at = $completedAt WHERE id = $id`,
      )
      .run({
        id,
        text: next.text,
        activities: JSON.stringify(next.activities),
        status: next.status,
        error: next.error ?? null,
        meta: currentMeta ? JSON.stringify(currentMeta) : null,
        completedAt: next.completedAt ?? null,
      });
    return next;
  }

  /** Reads the full stored metadata (including raw provider usage) for one message. */
  getMessageMeta(id: string): StoredMessageMeta | null {
    const row = this.db.query("SELECT meta FROM messages WHERE id = $id").get({ id }) as
      | { meta: string | null }
      | null;
    return parseMessageMeta(row?.meta ?? null);
  }

  getMessage(id: string): Message | null {
    const row = this.db.query("SELECT * FROM messages WHERE id = $id").get({ id }) as
      | MessageRow
      | null;
    if (!row) return null;
    return toMessage(row, this.listAttachmentsForMessage(id).map(publicAttachment));
  }

  listMessages(threadId: string): Message[] {
    const rows = this.db
      .query("SELECT * FROM messages WHERE thread_id = $threadId ORDER BY created_at, rowid")
      .all({ threadId }) as MessageRow[];
    const byMessage = new Map<string, Attachment[]>();
    for (const attachment of this.listAttachmentsForThread(threadId)) {
      if (!attachment.messageId) continue;
      const list = byMessage.get(attachment.messageId) ?? [];
      list.push(publicAttachment(attachment));
      byMessage.set(attachment.messageId, list);
    }
    return rows.map((row) => toMessage(row, byMessage.get(row.id) ?? []));
  }

  /** Searches one agent's past messages with SQLite FTS5. Never returns another agent's messages. */
  searchMessages(
    agentId: string,
    rawQuery: string,
    options: { limit?: number; excludeThreadId?: string } = {},
  ): ConversationSearchHit[] {
    const ftsQuery = buildFtsQuery(rawQuery);
    if (!ftsQuery) return [];
    const limit = Math.max(1, Math.min(25, options.limit ?? 10));
    const excludeThreadId = options.excludeThreadId ?? null;
    const rows = this.db
      .query(
        `SELECT
           m.id AS message_id,
           m.thread_id,
           t.title AS thread_title,
           t.source AS thread_source,
           m.role,
           snippet(messages_fts, 0, '[', ']', '…', 24) AS snippet,
           m.created_at
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN threads t ON t.id = m.thread_id
         WHERE messages_fts MATCH $ftsQuery
           AND t.agent_id = $agentId
           AND m.status != 'streaming'
           AND ($excludeThreadId IS NULL OR m.thread_id != $excludeThreadId)
         ORDER BY bm25(messages_fts), m.created_at DESC
         LIMIT $limit`,
      )
      .all({ ftsQuery, agentId, excludeThreadId, limit }) as Array<{
      message_id: string;
      thread_id: string;
      thread_title: string;
      thread_source: ThreadSource;
      role: MessageRole;
      snippet: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      threadSource: row.thread_source === "schedule" ? "schedule" : "chat",
      messageId: row.message_id,
      role: row.role,
      snippet: row.snippet,
      createdAt: row.created_at,
    }));
  }

  createAttachment(input: {
    id: string;
    threadId: string;
    messageId: string | null;
    name: string;
    mimeType: string;
    sizeBytes: number;
    storagePath: string;
  }): StoredAttachment {
    const createdAt = Date.now();
    this.db
      .query(
        `INSERT INTO attachments (id, thread_id, message_id, name, mime_type, size_bytes, storage_path, created_at)
         VALUES ($id, $threadId, $messageId, $name, $mimeType, $sizeBytes, $storagePath, $createdAt)`,
      )
      .run({
        id: input.id,
        threadId: input.threadId,
        messageId: input.messageId,
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        storagePath: input.storagePath,
        createdAt,
      });
    return {
      id: input.id,
      threadId: input.threadId,
      messageId: input.messageId,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      url: attachmentUrl(input.id),
      storagePath: input.storagePath,
      createdAt,
    };
  }

  getAttachment(id: string): StoredAttachment | null {
    const row = this.db.query("SELECT * FROM attachments WHERE id = $id").get({ id }) as
      | AttachmentRow
      | null;
    return row ? toAttachment(row) : null;
  }

  bindAttachments(ids: string[], messageId: string): StoredAttachment[] {
    if (ids.length === 0) return [];
    const bound: StoredAttachment[] = [];
    this.db.transaction(() => {
      const update = this.db.query("UPDATE attachments SET message_id = $messageId WHERE id = $id");
      for (const id of ids) {
        update.run({ id, messageId });
        const item = this.getAttachment(id);
        if (item) bound.push(item);
      }
    })();
    return bound;
  }

  listAttachmentsForMessage(messageId: string): StoredAttachment[] {
    const rows = this.db
      .query("SELECT * FROM attachments WHERE message_id = $messageId ORDER BY created_at, rowid")
      .all({ messageId }) as AttachmentRow[];
    return rows.map(toAttachment);
  }

  listAttachmentsForThread(threadId: string): StoredAttachment[] {
    const rows = this.db
      .query("SELECT * FROM attachments WHERE thread_id = $threadId AND message_id IS NOT NULL ORDER BY created_at, rowid")
      .all({ threadId }) as AttachmentRow[];
    return rows.map(toAttachment);
  }

  createScheduledTask(input: {
    agentId: string;
    name: string;
    prompt: string;
    schedule: TaskSchedule;
    enabled: boolean;
    harness: string | null;
    model: string | null;
    effort: string | null;
    fast: boolean;
    nextRunAt: number | null;
  }): ScheduledTask {
    const now = Date.now();
    const task: ScheduledTask = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      enabled: input.enabled,
      harness: input.harness,
      model: input.model,
      effort: input.effort,
      fast: input.fast,
      nextRunAt: input.nextRunAt,
      lastRunAt: null,
      lastRunThreadId: null,
      lastRunStatus: null,
      lastRunError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO scheduled_tasks (
           id, agent_id, name, prompt, schedule, enabled, harness, model, effort, fast,
           next_run_at, last_run_at, last_run_thread_id, last_run_status, last_run_error, created_at, updated_at
         ) VALUES (
           $id, $agentId, $name, $prompt, $schedule, $enabled, $harness, $model, $effort, $fast,
           $nextRunAt, NULL, NULL, NULL, NULL, $createdAt, $updatedAt
         )`,
      )
      .run({
        id: task.id,
        agentId: task.agentId,
        name: task.name,
        prompt: task.prompt,
        schedule: JSON.stringify(task.schedule),
        enabled: task.enabled ? 1 : 0,
        harness: task.harness,
        model: task.model,
        effort: task.effort,
        fast: task.fast ? 1 : 0,
        nextRunAt: task.nextRunAt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    return task;
  }

  getScheduledTask(id: string): ScheduledTask | null {
    const row = this.db.query("SELECT * FROM scheduled_tasks WHERE id = $id").get({ id }) as
      | ScheduledTaskRow
      | null;
    return row ? toScheduledTask(row) : null;
  }

  listScheduledTasks(agentId?: string): ScheduledTask[] {
    const rows = agentId
      ? (this.db
          .query("SELECT * FROM scheduled_tasks WHERE agent_id = $agentId ORDER BY created_at, rowid")
          .all({ agentId }) as ScheduledTaskRow[])
      : (this.db.query("SELECT * FROM scheduled_tasks ORDER BY created_at, rowid").all() as ScheduledTaskRow[]);
    return rows.map(toScheduledTask);
  }

  listDueScheduledTasks(now: number): ScheduledTask[] {
    const rows = this.db
      .query(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= $now
         ORDER BY next_run_at`,
      )
      .all({ now }) as ScheduledTaskRow[];
    return rows.map(toScheduledTask);
  }

  updateScheduledTask(
    id: string,
    patch: {
      name?: string;
      prompt?: string;
      schedule?: TaskSchedule;
      enabled?: boolean;
      harness?: string | null;
      model?: string | null;
      effort?: string | null;
      fast?: boolean;
      nextRunAt?: number | null;
      lastRunAt?: number | null;
      lastRunThreadId?: string | null;
      lastRunStatus?: ScheduledTaskRunStatus | null;
      lastRunError?: string | null;
    },
  ): ScheduledTask | null {
    const current = this.getScheduledTask(id);
    if (!current) return null;
    const next: ScheduledTask = {
      ...current,
      name: patch.name ?? current.name,
      prompt: patch.prompt ?? current.prompt,
      schedule: patch.schedule ?? current.schedule,
      enabled: patch.enabled ?? current.enabled,
      harness: patch.harness === undefined ? current.harness : patch.harness,
      model: patch.model === undefined ? current.model : patch.model,
      effort: patch.effort === undefined ? current.effort : patch.effort,
      fast: patch.fast ?? current.fast,
      nextRunAt: patch.nextRunAt === undefined ? current.nextRunAt : patch.nextRunAt,
      lastRunAt: patch.lastRunAt === undefined ? current.lastRunAt : patch.lastRunAt,
      lastRunThreadId: patch.lastRunThreadId === undefined ? current.lastRunThreadId : patch.lastRunThreadId,
      lastRunStatus: patch.lastRunStatus === undefined ? current.lastRunStatus : patch.lastRunStatus,
      lastRunError: patch.lastRunError === undefined ? current.lastRunError : patch.lastRunError,
      updatedAt: Date.now(),
    };
    this.db
      .query(
        `UPDATE scheduled_tasks SET
           name = $name, prompt = $prompt, schedule = $schedule, enabled = $enabled,
           harness = $harness, model = $model, effort = $effort, fast = $fast,
           next_run_at = $nextRunAt, last_run_at = $lastRunAt, last_run_thread_id = $lastRunThreadId,
           last_run_status = $lastRunStatus, last_run_error = $lastRunError, updated_at = $updatedAt
         WHERE id = $id`,
      )
      .run({
        id,
        name: next.name,
        prompt: next.prompt,
        schedule: JSON.stringify(next.schedule),
        enabled: next.enabled ? 1 : 0,
        harness: next.harness,
        model: next.model,
        effort: next.effort,
        fast: next.fast ? 1 : 0,
        nextRunAt: next.nextRunAt,
        lastRunAt: next.lastRunAt,
        lastRunThreadId: next.lastRunThreadId,
        lastRunStatus: next.lastRunStatus,
        lastRunError: next.lastRunError,
        updatedAt: next.updatedAt,
      });
    return next;
  }

  deleteScheduledTask(id: string): boolean {
    return this.db.query("DELETE FROM scheduled_tasks WHERE id = $id").run({ id }).changes > 0;
  }

  deleteScheduledTasksForAgent(agentId: string): number {
    return this.db.query("DELETE FROM scheduled_tasks WHERE agent_id = $agentId").run({ agentId }).changes;
  }

  createMemory(input: {
    agentId: string;
    block: MemoryBlock;
    text: string;
    status: MemoryStatus;
    proposedAction?: MemoryProposalAction | null;
    targetId?: string | null;
    source: MemorySource;
  }): MemoryEntry {
    const now = Date.now();
    const id = crypto.randomUUID();
    const threadId = input.source.kind === "thread" || input.source.kind === "schedule" ? input.source.threadId : null;
    const messageId =
      input.source.kind === "thread" || input.source.kind === "schedule"
        ? (input.source.messageId ?? null)
        : null;
    this.db
      .query(
        `INSERT INTO memories (
           id, agent_id, block, text, status, proposed_action, target_id, source, thread_id, message_id, created_at, updated_at
         ) VALUES (
           $id, $agentId, $block, $text, $status, $proposedAction, $targetId, $source, $threadId, $messageId, $createdAt, $updatedAt
         )`,
      )
      .run({
        id,
        agentId: input.agentId,
        block: input.block,
        text: input.text,
        status: input.status,
        proposedAction: input.proposedAction ?? null,
        targetId: input.targetId ?? null,
        source: JSON.stringify(input.source),
        threadId,
        messageId,
        createdAt: now,
        updatedAt: now,
      });
    return {
      id,
      agentId: input.agentId,
      block: input.block,
      text: input.text,
      status: input.status,
      ...(input.proposedAction ? { proposedAction: input.proposedAction } : {}),
      ...(input.targetId ? { targetId: input.targetId } : {}),
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };
  }

  getMemory(id: string): MemoryEntry | null {
    const row = this.db.query("SELECT * FROM memories WHERE id = $id").get({ id }) as MemoryRow | null;
    return row ? toMemory(row) : null;
  }

  listMemories(agentId: string, status?: MemoryStatus): MemoryEntry[] {
    const rows = status
      ? (this.db
          .query("SELECT * FROM memories WHERE agent_id = $agentId AND status = $status ORDER BY created_at, rowid")
          .all({ agentId, status }) as MemoryRow[])
      : (this.db
          .query("SELECT * FROM memories WHERE agent_id = $agentId ORDER BY created_at, rowid")
          .all({ agentId }) as MemoryRow[]);
    return rows.map(toMemory);
  }

  listThreadProposals(threadId: string): MemoryEntry[] {
    const rows = this.db
      .query("SELECT * FROM memories WHERE thread_id = $threadId AND status = 'proposed' ORDER BY created_at, rowid")
      .all({ threadId }) as MemoryRow[];
    return rows.map(toMemory);
  }

  updateMemory(
    id: string,
    patch: {
      block?: MemoryBlock;
      text?: string;
      status?: MemoryStatus;
      proposedAction?: MemoryProposalAction | null;
      targetId?: string | null;
    },
  ): MemoryEntry | null {
    const current = this.getMemory(id);
    if (!current) return null;
    const nextBlock = patch.block ?? current.block;
    const nextText = patch.text ?? current.text;
    const nextStatus = patch.status ?? current.status;
    const nextAction =
      patch.proposedAction === undefined ? (current.proposedAction ?? null) : patch.proposedAction;
    const nextTargetId = patch.targetId === undefined ? (current.targetId ?? null) : patch.targetId;
    const updatedAt = Date.now();
    this.db
      .query(
        `UPDATE memories SET block = $block, text = $text, status = $status,
           proposed_action = $proposedAction, target_id = $targetId, updated_at = $updatedAt
         WHERE id = $id`,
      )
      .run({
        id,
        block: nextBlock,
        text: nextText,
        status: nextStatus,
        proposedAction: nextAction,
        targetId: nextTargetId,
        updatedAt,
      });
    return {
      ...current,
      block: nextBlock,
      text: nextText,
      status: nextStatus,
      ...(nextAction ? { proposedAction: nextAction } : { proposedAction: undefined }),
      ...(nextTargetId ? { targetId: nextTargetId } : { targetId: undefined }),
      updatedAt,
    };
  }

  deleteMemory(id: string): boolean {
    return this.db.query("DELETE FROM memories WHERE id = $id").run({ id }).changes > 0;
  }

  deleteMemoriesForAgent(agentId: string): number {
    return this.db.query("DELETE FROM memories WHERE agent_id = $agentId").run({ agentId }).changes;
  }

  getPreferences(personId = DEFAULT_PERSON_ID): UserPreferences {
    const row = this.db
      .query("SELECT data FROM preferences WHERE person_id = $personId")
      .get({ personId }) as { data: string } | null;
    if (!row) return { ...DEFAULT_PREFERENCES };
    try {
      return normalizePreferences(JSON.parse(row.data));
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }

  updatePreferences(
    patch: UpdatePreferencesRequest,
    personId = DEFAULT_PERSON_ID,
  ): UserPreferences {
    const current = this.getPreferences(personId);
    const next: UserPreferences = {
      theme: patch.theme ?? current.theme,
      heroFont: patch.heroFont ?? current.heroFont,
      sidebarMode: patch.sidebarMode ?? current.sidebarMode,
    };
    this.db
      .query(
        `INSERT INTO preferences (person_id, data, updated_at)
         VALUES ($personId, $data, $updatedAt)
         ON CONFLICT(person_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run({
        personId,
        data: JSON.stringify(next),
        updatedAt: Date.now(),
      });
    return next;
  }
}

function normalizePreferences(value: unknown): UserPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_PREFERENCES };
  }
  const data = value as Record<string, unknown>;
  return {
    theme: isThemePreference(data.theme) ? data.theme : DEFAULT_PREFERENCES.theme,
    heroFont: isHeroFont(data.heroFont) ? data.heroFont : DEFAULT_PREFERENCES.heroFont,
    sidebarMode: isSidebarMode(data.sidebarMode) ? data.sidebarMode : DEFAULT_PREFERENCES.sidebarMode,
  };
}

function toThread(row: ThreadRow): StoredThread {
  const pendingProposals = row.pending_proposals ?? 0;
  return {
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    harness: row.harness,
    model: row.model,
    effort: row.effort,
    fast: row.fast === 1,
    source: row.source === "schedule" ? "schedule" : "chat",
    taskId: row.task_id,
    settledAt: row.settled_at,
    ...(pendingProposals > 0 ? { pendingProposals } : {}),
    sessionId: row.session_id,
    memorySnapshot: row.memory_snapshot ?? null,
    status: row.status,
    runningSince: row.running_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMemory(row: MemoryRow): MemoryEntry {
  let source: MemorySource = { kind: "person" };
  try {
    const parsed = JSON.parse(row.source) as MemorySource;
    if (parsed && typeof parsed === "object" && "kind" in parsed) source = parsed;
  } catch {
    // Fallback to person source if malformed.
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    block: row.block === "profile" ? "profile" : "notes",
    text: row.text,
    status: row.status === "proposed" ? "proposed" : "active",
    ...(row.proposed_action ? { proposedAction: row.proposed_action } : {}),
    ...(row.target_id ? { targetId: row.target_id } : {}),
    source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow, attachments: Attachment[]): Message {
  const message: Message = {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    text: row.text,
    activities: JSON.parse(row.activities) as Activity[],
    attachments,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.harness !== null) {
    message.harness = row.harness;
    message.model = row.model;
  }
  const meta = parseMessageMeta(row.meta);
  if (meta) message.stats = publicMessageStats(meta);
  if (row.error !== null) message.error = row.error;
  if (row.completed_at !== null) message.completedAt = row.completed_at;
  return message;
}

function parseMessageMeta(raw: string | null): StoredMessageMeta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as StoredMessageMeta;
    }
  } catch {
    // Ignore malformed metadata rows.
  }
  return null;
}

function publicMessageStats(meta: StoredMessageMeta): MessageStats {
  const { providerMeta: _providerMeta, ...stats } = meta;
  return stats;
}

function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}`;
}

function toAttachment(row: AttachmentRow): StoredAttachment {
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    url: attachmentUrl(row.id),
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

function toScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    prompt: row.prompt,
    schedule: JSON.parse(row.schedule) as TaskSchedule,
    enabled: row.enabled === 1,
    harness: row.harness,
    model: row.model,
    effort: row.effort,
    fast: row.fast === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunThreadId: row.last_run_thread_id,
    lastRunStatus: row.last_run_status,
    lastRunError: row.last_run_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The public view of a thread, without harness-internal fields. */
export function publicThread(thread: StoredThread): ThreadSummary {
  const { sessionId: _sessionId, memorySnapshot: _memorySnapshot, ...summary } = thread;
  return summary;
}

/**
 * Turns a plain search string into a safe FTS5 MATCH expression by quoting each phrase
 * or token so that punctuation such as hyphens, colons, or apostrophes never triggers
 * an FTS5 syntax error.
 */
export function buildFtsQuery(raw: string): string {
  const parts: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const token = (match[1] ?? match[2] ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!token) continue;
    // Skip pure punctuation tokens that unicode61 tokenizes to nothing.
    if (!/[\p{L}\p{N}]/u.test(token)) continue;
    parts.push(`"${token.replaceAll('"', '""')}"`);
  }
  return parts.join(" ");
}

/** The public view of an attachment, without its path on disk. */
export function publicAttachment(attachment: StoredAttachment): Attachment {
  const { storagePath: _storagePath, ...pub } = attachment;
  return pub;
}
