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
  status TEXT NOT NULL,            -- 'open' | 'closing' | 'closed' | 'archived' (na reset statistieken)
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
  graduated INTEGER NOT NULL DEFAULT 0,
  entry_market_price_sol REAL,     -- on-chain prijs bij aankoop (vergelijk met entry_price_sol)
  exit_trigger_price_sol REAL,     -- prijs waarop de exit-regel triggerde (vergelijk met exit_price_sol)
  -- Analyse (MFE/MAE): hoogste/laagste prijs tijdens het houden en na de exit
  peak_price_at INTEGER,
  min_price_sol REAL,
  min_price_at INTEGER,
  post_max_price_sol REAL,
  post_max_at INTEGER,
  post_min_price_sol REAL,
  post_min_at INTEGER,
  post_graduated INTEGER,          -- 1 = token gegradueerd binnen het venster na de exit
  post_watch_until INTEGER,        -- tot wanneer de prijs na de exit gevolgd wordt
  -- Experimenthygiëne
  config_hash TEXT,                -- hash van de instellingen bij aankoop (zie tabel settings_versions)
  run_id TEXT,                     -- opstart van de bot (= naam van het logbestand)
  -- Gedeeltelijke verkopen (inzet eruit / deel take-profit)
  tokens_sold_raw TEXT NOT NULL DEFAULT '0', -- al verkochte tokens (bigint als string)
  realized_sol REAL NOT NULL DEFAULT 0,       -- SOL ontvangen uit deelverkopen
  partial_done TEXT NOT NULL DEFAULT '',      -- uitgevoerde niveaus, kommagescheiden (init, tp50, ...)
  -- Tokendata op het moment van aankoop
  entry_age_min REAL,
  entry_mcap_usd REAL,
  entry_vol_total_usd REAL,
  entry_vol10m_usd REAL,
  entry_price_change_pct REAL,
  entry_holders INTEGER,          -- aantal holders (zonder bonding curve); bij RPC max. 19 = ondergrens
  entry_top10_pct REAL,
  entry_creator_pct REAL,
  entry_rt_loss_pct REAL,
  -- Tijdstempels en prijzen per stap van de aankoop
  eval_at INTEGER,                 -- evaluatie (filters gehaald)
  eval_price_sol REAL,
  check_at INTEGER,                -- veiligheidscheck klaar (verse on-chain curve)
  check_price_sol REAL,
  sent_at INTEGER,                 -- transactie verzonden
  sent_price_sol REAL,
  landed_at INTEGER,               -- transactie geland (fill)
  landed_price_sol REAL,           -- marktprijs op het moment van landen
  -- Koerspad na instap: {"1": prijs, "3": ..., "30": ...} (seconden na de fill)
  path_json TEXT,
  -- Tijd boven winstdrempels tijdens het houden
  secs_above_20 REAL NOT NULL DEFAULT 0,
  secs_above_50 REAL NOT NULL DEFAULT 0,
  first_20_at INTEGER,
  first_50_at INTEGER,
  mom_60s_pct REAL,                -- momentum vlak vóór aankoop/afwijzing (% over 60/30/10/1 s)
  mom_30s_pct REAL,
  mom_10s_pct REAL,
  mom_1s_pct REAL
);

-- Tokens die (bijna) gekocht werden maar zijn afgewezen, met de koers daarna (counterfactual)
CREATE TABLE IF NOT EXISTS skipped_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  symbol TEXT,
  at INTEGER NOT NULL,
  stage TEXT NOT NULL,             -- 'filter' (precies één filter niet gehaald) | 'holders' | 'veiligheid' | 'koop'
  reason_key TEXT NOT NULL,        -- filtersleutel of korte reden
  reason TEXT NOT NULL,            -- leesbare reden
  value TEXT,                      -- gemeten waarde van het afwijzende filter
  required TEXT,                   -- vereiste waarde
  price_sol REAL,
  age_min REAL,
  mcap_usd REAL,
  vol_total_usd REAL,
  vol10m_usd REAL,
  price_change_pct REAL,
  holders INTEGER,
  top10_pct REAL,
  creator_pct REAL,
  checks_json TEXT,                -- alle filterresultaten op dat moment
  config_hash TEXT,
  run_id TEXT,
  post_watch_until INTEGER,
  post_max_price_sol REAL,
  post_max_at INTEGER,
  post_min_price_sol REAL,
  post_min_at INTEGER,
  post_last_price_sol REAL,
  post_graduated INTEGER NOT NULL DEFAULT 0,
  mom_60s_pct REAL,                -- momentum vlak vóór aankoop/afwijzing (% over 60/30/10/1 s)
  mom_30s_pct REAL,
  mom_10s_pct REAL,
  mom_1s_pct REAL,
  UNIQUE (mint, stage, reason_key)
);
CREATE INDEX IF NOT EXISTS idx_skipped_watch ON skipped_tokens(post_watch_until);

CREATE TABLE IF NOT EXISTS position_sells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- 'INIT' | 'PTP' | eindverkoop: 'SL' | 'TP' | 'TRAIL' | ...
  level_key TEXT,
  tokens_raw TEXT NOT NULL,
  sol REAL NOT NULL,               -- netto ontvangen SOL
  price_sol REAL,                  -- effectieve verkoopprijs per token
  trigger_price_sol REAL,
  pnl_pct_at_trigger REAL,
  sig TEXT,
  sent_at INTEGER,
  cost_sol REAL,                   -- deel van de inleg dat bij deze tokens hoort
  pnl_sol REAL,                    -- opbrengst minus dat deel van de inleg
  pnl_pct REAL
);
CREATE INDEX IF NOT EXISTS idx_sells_position ON position_sells(position_id);
CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed_at);

CREATE TABLE IF NOT EXISTS settings_versions (
  hash TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  first_used_at INTEGER NOT NULL
);

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
  // Migraties voor bestaande databases
  const cols = new Set((db.prepare('PRAGMA table_info(positions)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('entry_market_price_sol')) db.exec('ALTER TABLE positions ADD COLUMN entry_market_price_sol REAL');
  if (!cols.has('exit_trigger_price_sol')) db.exec('ALTER TABLE positions ADD COLUMN exit_trigger_price_sol REAL');
  const added: [string, string][] = [
    ['peak_price_at', 'INTEGER'],
    ['min_price_sol', 'REAL'],
    ['min_price_at', 'INTEGER'],
    ['post_max_price_sol', 'REAL'],
    ['post_max_at', 'INTEGER'],
    ['post_min_price_sol', 'REAL'],
    ['post_min_at', 'INTEGER'],
    ['post_graduated', 'INTEGER'],
    ['post_watch_until', 'INTEGER'],
    ['config_hash', 'TEXT'],
    ['run_id', 'TEXT'],
    ['tokens_sold_raw', "TEXT NOT NULL DEFAULT '0'"],
    ['realized_sol', 'REAL NOT NULL DEFAULT 0'],
    ['partial_done', "TEXT NOT NULL DEFAULT ''"],
    ['entry_age_min', 'REAL'],
    ['entry_mcap_usd', 'REAL'],
    ['entry_vol_total_usd', 'REAL'],
    ['entry_vol10m_usd', 'REAL'],
    ['entry_price_change_pct', 'REAL'],
    ['entry_holders', 'INTEGER'],
    ['entry_top10_pct', 'REAL'],
    ['entry_creator_pct', 'REAL'],
    ['entry_rt_loss_pct', 'REAL'],
    ['eval_at', 'INTEGER'],
    ['eval_price_sol', 'REAL'],
    ['check_at', 'INTEGER'],
    ['check_price_sol', 'REAL'],
    ['sent_at', 'INTEGER'],
    ['sent_price_sol', 'REAL'],
    ['landed_at', 'INTEGER'],
    ['landed_price_sol', 'REAL'],
    ['path_json', 'TEXT'],
    ['secs_above_20', 'REAL NOT NULL DEFAULT 0'],
    ['secs_above_50', 'REAL NOT NULL DEFAULT 0'],
    ['first_20_at', 'INTEGER'],
    ['first_50_at', 'INTEGER'],
    ['mom_60s_pct', 'REAL'],
    ['mom_30s_pct', 'REAL'],
    ['mom_10s_pct', 'REAL'],
    ['mom_1s_pct', 'REAL'],
  ];
  for (const [name, type] of added) if (!cols.has(name)) db.exec(`ALTER TABLE positions ADD COLUMN ${name} ${type}`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_positions_watch ON positions(post_watch_until)');
  const skipCols = new Set((db.prepare('PRAGMA table_info(skipped_tokens)').all() as { name: string }[]).map((c) => c.name));
  for (const name of ['mom_60s_pct', 'mom_30s_pct', 'mom_10s_pct', 'mom_1s_pct']) if (!skipCols.has(name)) db.exec(`ALTER TABLE skipped_tokens ADD COLUMN ${name} REAL`);
  const sellCols = new Set((db.prepare('PRAGMA table_info(position_sells)').all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of [['sent_at', 'INTEGER'], ['cost_sol', 'REAL'], ['pnl_sol', 'REAL'], ['pnl_pct', 'REAL']] as const) {
    if (!sellCols.has(name)) db.exec(`ALTER TABLE position_sells ADD COLUMN ${name} ${type}`);
  }
  // Trades van vóór de config-hash: markeren als "legacy" (de instellingen van toen zijn niet bewaard)
  db.exec(`UPDATE positions SET run_id = 'legacy_' || strftime('%Y-%m-%d', opened_at / 1000, 'unixepoch', 'localtime') WHERE run_id IS NULL`);
  db.exec("UPDATE positions SET config_hash = 'legacy' WHERE config_hash IS NULL");
  db.prepare('INSERT OR IGNORE INTO settings_versions (hash, json, first_used_at) VALUES (?, ?, ?)').run(
    'legacy',
    JSON.stringify({ opmerking: 'Trades van vóór de invoering van de config-hash; de instellingen van toen zijn niet bewaard.' }),
    0,
  );
  return db;
}

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
