import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  mode TEXT NOT NULL,              -- 'paper' | 'live'
  status TEXT NOT NULL,            -- 'open' | 'closing' | 'closed'
  executor TEXT,
  entry_sol REAL NOT NULL,         -- totaal uitgegeven SOL (incl. fees)
  token_amount_raw TEXT NOT NULL,  -- bigint als string
  decimals INTEGER NOT NULL,
  entry_price_sol REAL NOT NULL,   -- SOL per token (effectief, incl. fees)
  opened_at INTEGER NOT NULL,
  peak_price_sol REAL NOT NULL,
  last_price_sol REAL,
  last_price_at INTEGER,
  pending_exit TEXT,               -- reden van een getriggerde maar nog niet gelukte verkoop
  sell_attempts INTEGER NOT NULL DEFAULT 0,
  next_sell_at INTEGER,
  last_error TEXT,
  exit_sol REAL,
  exit_price_sol REAL,
  closed_at INTEGER,
  exit_reason TEXT,                -- 'SL' | 'TP' | 'TIME' | 'TRAIL' | 'MANUAL' | 'SELL_ALL'
  pnl_sol REAL,
  pnl_pct REAL,
  buy_sig TEXT,
  sell_sig TEXT,
  graduated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed_at);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
