import type { Db } from '../db.js';
import { logger, runId } from '../logger.js';
import type { FilterCheck } from './filters.js';
import { lastPrice, type TokenMetrics } from './metrics.js';
import type { Momentum } from './momentum.js';
import type { TokenTracker } from './tracker.js';

export type SkipStage = 'filter' | 'holders' | 'veiligheid' | 'momentum' | 'koop';

export interface SkipRecord {
  stage: SkipStage;
  /** Filtersleutel of korte reden; per token + stage + sleutel wordt maar één keer vastgelegd. */
  reasonKey: string;
  reason: string;
  value?: string | null;
  required?: string | null;
  checks?: FilterCheck[];
  top10Pct?: number | null;
  creatorPct?: number | null;
  holders?: number | null;
  momentum?: Momentum | null;
}

interface SkipRow {
  id: number;
  mint: string;
  symbol: string | null;
  stage: string;
  reason: string;
  price_sol: number | null;
  post_max_price_sol: number | null;
  post_min_price_sol: number | null;
  post_last_price_sol: number | null;
  post_graduated: number;
  post_watch_until: number;
}

/** Max. aantal overgeslagen tokens dat tegelijk gevolgd wordt (RPC-belasting begrenzen). */
const MAX_WATCHED = 300;

const pctOf = (p: number | null, ref: number | null) => (p !== null && ref ? +((p / ref - 1) * 100).toFixed(1) : null);

/**
 * Counterfactual: legt tokens vast die (bijna) gekocht werden maar zijn afgewezen, met de
 * reden en de waarden op dat moment, en volgt daarna de koers even lang als bij trades.
 * Zo is te zien of een filter verliezers tegenhoudt of ook winnaars wegfiltert.
 */
export class SkipLog {
  /** mint|stage|sleutel → al vastgelegd (scheelt een DB-call per evaluatie). */
  private seen = new Set<string>();
  private timer?: NodeJS.Timeout;
  private watching = new Map<number, string>();

  constructor(
    private db: Db,
    private tracker: TokenTracker,
    private watchMin: () => number,
    private configHash: () => string,
  ) {
    for (const r of this.watched()) this.pin(r.id, r.mint);
    tracker.keepAlive.push((mint) => this.keeps(mint));
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), 5000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private pin(id: number, mint: string) {
    this.watching.set(id, mint);
    this.tracker.ensure(mint);
  }

  /** Of een token nog gevolgd moet blijven (tracker ruimt het dan niet op). */
  keeps(mint: string): boolean {
    for (const m of this.watching.values()) if (m === mint) return true;
    return false;
  }

  record(m: TokenMetrics, r: SkipRecord, now = Date.now()): boolean {
    const key = `${m.mint}|${r.stage}|${r.reasonKey}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const watchMin = this.watchMin();
    const track = watchMin > 0 && this.watching.size < MAX_WATCHED;
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO skipped_tokens (mint, symbol, at, stage, reason_key, reason, value, required, price_sol, age_min, mcap_usd,
          vol_total_usd, vol10m_usd, price_change_pct, holders, top10_pct, creator_pct, checks_json, config_hash, run_id,
          post_watch_until, post_max_price_sol, post_min_price_sol, post_last_price_sol, mom_60s_pct, mom_30s_pct, mom_10s_pct, mom_1s_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.mint,
        m.symbol,
        now,
        r.stage,
        r.reasonKey,
        r.reason.slice(0, 300),
        r.value ?? null,
        r.required ?? null,
        m.priceSol,
        m.ageMin,
        m.marketCapUsd,
        m.volumeTotalUsd,
        m.volume10mUsd,
        m.priceChangePct,
        r.holders ?? m.holders,
        r.top10Pct ?? null,
        r.creatorPct ?? null,
        r.checks ? JSON.stringify(r.checks.map((c) => ({ k: c.key, ok: c.pass, v: c.value, nodig: c.required }))) : null,
        this.configHash(),
        runId,
        track ? now + watchMin * 60_000 : null,
        m.priceSol,
        m.priceSol,
        m.priceSol,
        r.momentum?.m60 ?? null,
        r.momentum?.m30 ?? null,
        r.momentum?.m10 ?? null,
        r.momentum?.m1 ?? null,
      );
    if (!Number(res.changes)) return false;
    if (track) this.pin(Number(res.lastInsertRowid), m.mint);
    return true;
  }

  /** Alle overgeslagen tokens met de koers na afwijzing in %, voor export. */
  forExport(): Record<string, unknown>[] {
    const pct = (a: string) => `ROUND((${a} / NULLIF(price_sol, 0) - 1) * 100, 2)`;
    return this.db
      .prepare(
        `SELECT id, strftime('%Y-%m-%d %H:%M:%S', at / 1000, 'unixepoch', 'localtime') AS tijd, mint, symbol, stage AS fase, reason AS reden,
          value AS waarde, required AS nodig, price_sol AS prijs, ROUND(age_min, 2) AS leeftijd_min, ROUND(mcap_usd) AS mcap_usd,
          ROUND(vol_total_usd) AS volume_totaal_usd, ROUND(vol10m_usd) AS volume_10m_usd, ROUND(price_change_pct, 1) AS stijging_pct,
          holders, ROUND(top10_pct, 1) AS top10_pct, ROUND(creator_pct, 1) AS maker_pct,
          mom_60s_pct AS momentum_60s_pct, mom_30s_pct AS momentum_30s_pct, mom_10s_pct AS momentum_10s_pct, mom_1s_pct AS momentum_1s_pct,
          ${pct('post_max_price_sol')} AS max_na_afwijzing_pct, ROUND((post_max_at - at) / 60000.0, 1) AS max_na_min,
          ${pct('post_min_price_sol')} AS min_na_afwijzing_pct, ${pct('post_last_price_sol')} AS eind_pct,
          post_graduated AS gegradueerd, CASE WHEN post_watch_until IS NULL THEN 'nee' WHEN post_watch_until > ? THEN 'loopt' ELSE 'klaar' END AS gevolgd,
          config_hash, run_id, checks_json AS alle_filters
        FROM skipped_tokens ORDER BY at`,
      )
      .all(Date.now()) as Record<string, unknown>[];
  }

  private watched(now = Date.now()): SkipRow[] {
    return this.db.prepare('SELECT * FROM skipped_tokens WHERE post_watch_until > ?').all(now) as unknown as SkipRow[];
  }

  /** Koers van gevolgde overgeslagen tokens bijwerken (prijzen komen uit de tracker: curve-poll of DexScreener). */
  tick(now = Date.now()) {
    const rows = this.watched(now);
    const active = new Set(rows.map((r) => r.id));
    for (const r of rows) {
      const t = this.tracker.tokens.get(r.mint);
      if (!t) continue;
      const p = lastPrice(t)?.priceSol ?? null;
      const graduated = t.graduated ? 1 : 0;
      if (p === null && graduated === r.post_graduated) continue;
      const max = p !== null && (r.post_max_price_sol === null || p > r.post_max_price_sol);
      const min = p !== null && (r.post_min_price_sol === null || p < r.post_min_price_sol);
      this.db
        .prepare(
          `UPDATE skipped_tokens SET post_last_price_sol = COALESCE(?, post_last_price_sol), post_graduated = MAX(post_graduated, ?),
            post_max_price_sol = CASE WHEN ? THEN ? ELSE post_max_price_sol END, post_max_at = CASE WHEN ? THEN ? ELSE post_max_at END,
            post_min_price_sol = CASE WHEN ? THEN ? ELSE post_min_price_sol END, post_min_at = CASE WHEN ? THEN ? ELSE post_min_at END
           WHERE id = ?`,
        )
        .run(p, graduated, max ? 1 : 0, p, max ? 1 : 0, now, min ? 1 : 0, p, min ? 1 : 0, now, r.id);
    }
    // Afgelopen vensters: samenvatting loggen en token vrijgeven
    for (const [id, mint] of this.watching) {
      if (active.has(id)) continue;
      this.watching.delete(id);
      const r = this.db.prepare('SELECT * FROM skipped_tokens WHERE id = ?').get(id) as unknown as SkipRow | undefined;
      if (!r) continue;
      logger.info(
        {
          symbol: r.symbol,
          mint: r.mint,
          stage: r.stage,
          reden: r.reason,
          maxNaAfwijzingPct: pctOf(r.post_max_price_sol, r.price_sol),
          minNaAfwijzingPct: pctOf(r.post_min_price_sol, r.price_sol),
          eindPct: pctOf(r.post_last_price_sol, r.price_sol),
          gegradueerd: Boolean(r.post_graduated),
        },
        'overgeslagen token: koers na afwijzing (counterfactual)',
      );
    }
  }
}
