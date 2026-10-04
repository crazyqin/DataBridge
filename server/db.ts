import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS = [
  `
  CREATE TABLE admin (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE api_key (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE datasource (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    database TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    ssl TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE api (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    method TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agents TEXT NOT NULL,
    mode TEXT NOT NULL,
    datasource_id INTEGER REFERENCES datasource(id),
    sql_text TEXT,
    params TEXT NOT NULL,
    fields TEXT NOT NULL,
    filters TEXT NOT NULL,
    key_fields TEXT NOT NULL,
    cron TEXT,
    allow_empty INTEGER NOT NULL,
    timeout_seconds INTEGER NOT NULL,
    max_rows INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    sync_at TEXT,
    sync_status TEXT,
    sync_count INTEGER,
    sync_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (path, method)
  );
  CREATE TABLE api_row (
    api_id INTEGER NOT NULL REFERENCES api(id) ON DELETE CASCADE,
    row_key TEXT NOT NULL,
    data TEXT NOT NULL,
    position INTEGER NOT NULL,
    sort INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (api_id, row_key)
  );
  CREATE INDEX api_row_order ON api_row (api_id, sort, position);
  CREATE TABLE request_log (
    id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL,
    at TEXT NOT NULL,
    api_id INTEGER,
    mode TEXT,
    elapsed_ms INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT
  );
  CREATE INDEX request_log_at ON request_log (at);
  `,
  `ALTER TABLE api_row ADD COLUMN remark TEXT NOT NULL DEFAULT '';`,
  `
  ALTER TABLE api ADD COLUMN cron_timezone TEXT;
  CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY,
    api_id INTEGER NOT NULL REFERENCES api(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    row_count INTEGER,
    error TEXT
  );
  CREATE INDEX sync_log_api_id ON sync_log (api_id, id DESC);
  `,
  `ALTER TABLE api ADD COLUMN external_auth TEXT;`,
]

export type Db = DatabaseSync

export function openDb(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let version = current; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version])
      db.exec(`PRAGMA user_version = ${version + 1}`)
    })
  }
  return db
}

/** Runs fn atomically. SQLite calls are synchronous, so nothing else interleaves with it. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export const now = () => new Date().toISOString()
