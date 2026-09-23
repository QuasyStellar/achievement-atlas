import sqlite3 from 'sqlite3';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Mutex } from '../application/mutex.js';
import type { Connection, Storage } from '../application/ports/storage.js';

export { Mutex };
export type { Connection };
export class Database implements Storage {
  private readonly mutex = new Mutex();
  readonly connection: Connection;
  private closed = false;
  private constructor(private readonly raw: sqlite3.Database, readonly path: string) {
    this.connection = {
      run: (sql, params = []) => new Promise((resolve, reject) => {
        raw.run(sql, params, function (err) { if (err) reject(err); else resolve({ changes: this.changes, lastID: this.lastID }); });
      }),
      get: <T>(sql: string, params: unknown[] = []) => new Promise<T | undefined>((resolve, reject) => {
        raw.get(sql, params, (err: Error | null, row: T | undefined) => err ? reject(err) : resolve(row));
      }),
      all: <T>(sql: string, params: unknown[] = []) => new Promise<T[]>((resolve, reject) => {
        raw.all(sql, params, (err: Error | null, rows: T[]) => err ? reject(err) : resolve(rows));
      }),
      exec: sql => new Promise((resolve, reject) => raw.exec(sql, err => err ? reject(err) : resolve())),
    };
  }
  static async open(path: string): Promise<Database> {
    if (path !== ':memory:') await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const raw = await new Promise<sqlite3.Database>((resolve, reject) => {
      const instance = new sqlite3.Database(path, err => err ? reject(err) : resolve(instance));
    });
    const db = new Database(raw, path);
    try {
      if (path !== ':memory:') await chmod(path, 0o600);
      await db.read(c => c.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;'));
      await db.transaction(async c => {
        await c.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
        const migrated = await c.get<{ version: number }>('SELECT version FROM schema_migrations WHERE version=1');
        if (!migrated) {
          await c.exec(SCHEMA);
          await c.run('INSERT INTO schema_migrations VALUES(1,?)', [new Date().toISOString()]);
        }
      });
      return db;
    } catch (error) { await db.close(); throw error; }
  }
  read<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    return this.mutex.run(() => { if (this.closed) throw new Error('Database is closed'); return fn(this.connection); });
  }
  transaction<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    return this.read(async c => {
      await c.exec('BEGIN IMMEDIATE');
      try { const value = await fn(c); await c.exec('COMMIT'); return value; }
      catch (error) { await c.exec('ROLLBACK'); throw error; }
    });
  }
  close(): Promise<void> {
    return this.mutex.run(async () => {
      if (this.closed) return;
      await new Promise<void>((resolve, reject) => this.raw.close(err => err ? reject(err) : resolve()));
      this.closed = true;
    });
  }
}
const SCHEMA = `
CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player' CHECK(role IN ('player','operator')), created_at TEXT NOT NULL
);
CREATE TABLE counters (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 matches INTEGER NOT NULL DEFAULT 0 CHECK(matches>=0), wins INTEGER NOT NULL DEFAULT 0 CHECK(wins>=0),
 kills INTEGER NOT NULL DEFAULT 0 CHECK(kills>=0), xp INTEGER NOT NULL DEFAULT 0 CHECK(xp>=0)
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE events (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, event_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
 result TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source,event_id)
);
CREATE INDEX events_user ON events(user_id,created_at DESC);
CREATE TABLE unlocks (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), achievement_id TEXT NOT NULL,
 unlocked_at TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES events(id), UNIQUE(user_id,achievement_id)
);
CREATE INDEX unlocks_user ON unlocks(user_id);
CREATE TABLE mint_jobs (
 id TEXT PRIMARY KEY, unlock_id TEXT NOT NULL UNIQUE REFERENCES unlocks(id), recipient TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','submitted','confirmed','failed')),
 item_index INTEGER UNIQUE, item_address TEXT, transaction_hash TEXT, error TEXT,
 signed_boc TEXT, message_hash TEXT, wallet_seqno INTEGER, deadline INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX mint_jobs_queue ON mint_jobs(status,created_at);
`;
