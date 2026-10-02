import type { Connection } from '@solana/web3.js';
import type { Db } from '../db.js';
import type { Executor, Fill } from '../executor/types.js';
import { logger } from '../logger.js';
import { bondingCurvePda, curvePriceSol, decodeCurve, fetchCurves } from '../market/bondingCurve.js';
import { fetchDexInfo } from '../market/dexscreener.js';
import { jupPricesUsd } from '../market/jupiter.js';
import { solUsd } from '../market/solPrice.js';
import type { Settings } from '../settings.js';
import { evaluateExit, type ExitReason } from './exits.js';
import { addPrice } from './metrics.js';
import type { TokenTracker } from './tracker.js';

export interface PositionRow {
  id: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  mode: 'paper' | 'live';
  status: 'open' | 'closing' | 'closed' | 'archived';
  executor: string | null;
  entry_sol: number;
  token_amount_raw: string;
  decimals: number;
  entry_price_sol: number;
  opened_at: number;
  peak_price_sol: number;
  last_price_sol: number | null;
  last_price_at: number | null;
  pending_exit: ExitReason | null;
  sell_attempts: number;
  next_sell_at: number | null;
  last_error: string | null;
  exit_sol: number | null;
  exit_price_sol: number | null;
  closed_at: number | null;
  exit_reason: ExitReason | null;
  pnl_sol: number | null;
  pnl_pct: number | null;
  buy_sig: string | null;
  sell_sig: string | null;
  graduated: number;
}

export interface OpenPositionView extends PositionRow {
  valueSol: number | null;
  livePnlSol: number | null;
  livePnlPct: number | null;
  heldMin: number;
}

export function tokensUi(p: Pick<PositionRow, 'token_amount_raw' | 'decimals'>): number {
  return Number(BigInt(p.token_amount_raw)) / 10 ** p.decimals;
}

/** Houdt posities bij in SQLite en bewaakt exit-regels. */
export class PositionManager {
  private selling = new Set<number>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  /** mint → websocket-subscriptie op de bonding curve (realtime prijs). */
  private subs = new Map<string, number>();
  private lastExternalFetch = 0;

  constructor(
    private db: Db,
    private conn: Connection,
    private tracker: TokenTracker,
    private settings: () => Settings,
    private executorFor: (mode: 'paper' | 'live') => Executor | null,
  ) {
    // Posities die midden in een verkoop zaten bij een crash weer openzetten
    db.prepare("UPDATE positions SET status = 'open' WHERE status = 'closing'").run();
    for (const p of this.open()) {
      this.tracker.ensure(p.mint, p.symbol ?? '', p.name ?? '');
      this.tracker.pinned.add(p.mint);
    }
  }

  start() {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.settings().tracker.positionPollSec * 1000);
    this.syncSubscriptions();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const id of this.subs.values()) void this.conn.removeAccountChangeListener(id).catch(() => undefined);
    this.subs.clear();
  }

  /**
   * Abonneert op de bonding curve van elke open positie (RPC-websocket, gratis).
   * Elke curve-wijziging wordt direct tegen de exit-regels gehouden, i.p.v. pas bij de volgende poll.
   */
  private syncSubscriptions() {
    const wanted = new Set(this.open().map((r) => r.mint).filter((m) => !this.tracker.tokens.get(m)?.graduated));
    for (const [mint, id] of this.subs) {
      if (!wanted.has(mint)) {
        void this.conn.removeAccountChangeListener(id).catch(() => undefined);
        this.subs.delete(mint);
      }
    }
    for (const mint of wanted) {
      if (this.subs.has(mint)) continue;
      try {
        const id = this.conn.onAccountChange(
          bondingCurvePda(mint),
          (info) => {
            const c = decodeCurve(info.data);
            if (!c) return;
            const t = this.tracker.tokens.get(mint);
            if (t) {
              t.curve = c;
              t.curveUpdatedAt = Date.now();
              if (c.complete) t.graduated = true;
            }
            if (c.complete) return;
            const price = curvePriceSol(c);
            if (t) addPrice(t, { t: Date.now(), priceSol: price });
            for (const r of this.open()) if (r.mint === mint && r.status === 'open') this.handlePrice(r, price, Date.now());
          },
          { commitment: 'processed' },
        );
        this.subs.set(mint, id);
      } catch (e) {
        logger.debug({ mint, err: String(e) }, 'curve-subscriptie mislukt');
      }
    }
  }

  /** Verwerkt een nieuwe prijs voor een positie: piek bijwerken en exit-regels toetsen. */
  private handlePrice(r: PositionRow, price: number | null, now: number) {
    if (this.selling.has(r.id)) return;
    if (price !== null) {
      const peak = Math.max(r.peak_price_sol, price);
      this.db.prepare('UPDATE positions SET last_price_sol = ?, last_price_at = ?, peak_price_sol = ? WHERE id = ?').run(price, now, peak, r.id);
      r.peak_price_sol = peak;
    }
    // Eerder getriggerde exit die mislukte: opnieuw proberen (failsafe)
    if (r.pending_exit) {
      if (!r.next_sell_at || now >= r.next_sell_at) void this.sell(r.id, r.pending_exit);
      return;
    }
    const reason = evaluateExit({ entryPriceSol: r.entry_price_sol, peakPriceSol: r.peak_price_sol, openedAt: r.opened_at }, price, now, this.settings().exits);
    if (reason) {
      logger.info({ id: r.id, symbol: r.symbol, reason, price, entry: r.entry_price_sol }, 'exit-regel geraakt');
      void this.sell(r.id, reason);
    }
  }

  open(): PositionRow[] {
    return this.db.prepare("SELECT * FROM positions WHERE status IN ('open','closing') ORDER BY opened_at").all() as unknown as PositionRow[];
  }

  get(id: number): PositionRow | undefined {
    return this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as unknown as PositionRow | undefined;
  }

  everBought(mint: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM positions WHERE mint = ? LIMIT 1').get(mint));
  }

  record(p: { mint: string; symbol: string; name: string; mode: 'paper' | 'live'; fill: Fill; graduated: boolean }): PositionRow {
    const ui = Number(p.fill.tokenAmountRaw) / 10 ** p.fill.decimals;
    const entryPrice = ui > 0 ? p.fill.solAmount / ui : 0;
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO positions (mint, symbol, name, mode, status, executor, entry_sol, token_amount_raw, decimals, entry_price_sol,
          opened_at, peak_price_sol, last_price_sol, last_price_at, buy_sig, graduated)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.mint,
        p.symbol,
        p.name,
        p.mode,
        p.fill.executor,
        p.fill.solAmount,
        p.fill.tokenAmountRaw.toString(),
        p.fill.decimals,
        entryPrice,
        now,
        entryPrice,
        entryPrice,
        now,
        p.fill.signature ?? null,
        p.graduated ? 1 : 0,
      );
    this.tracker.pinned.add(p.mint);
    this.syncSubscriptions();
    return this.get(Number(res.lastInsertRowid))!;
  }

  /** Haalt actuele prijzen op voor alle open posities. Curve on-chain, anders Jupiter/DexScreener. */
  private async fetchPrices(rows: PositionRow[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const mints = [...new Set(rows.map((r) => r.mint))];
    const onCurve = mints.filter((m) => !this.tracker.tokens.get(m)?.graduated);
    try {
      const curves = await fetchCurves(this.conn, onCurve);
      for (const [mint, c] of curves) {
        const t = this.tracker.tokens.get(mint);
        if (t) {
          t.curve = c;
          t.curveUpdatedAt = Date.now();
          if (c.complete) t.graduated = true;
        }
        if (!c.complete) prices.set(mint, curvePriceSol(c));
      }
    } catch (e) {
      logger.debug({ err: String(e) }, 'curve-prijzen positie mislukt');
    }
    const rest = mints.filter((m) => !prices.has(m));
    // Jupiter/DexScreener zijn gelimiteerd: max. elke 3 s
    if (rest.length && Date.now() - this.lastExternalFetch >= 3000) {
      this.lastExternalFetch = Date.now();
      try {
        const [usd, sol] = await Promise.all([jupPricesUsd(rest), solUsd()]);
        for (const [mint, p] of usd) if (sol > 0) prices.set(mint, p / sol);
      } catch (e) {
        logger.debug({ err: String(e) }, 'Jupiter-prijzen mislukt, probeer DexScreener');
      }
      const still = rest.filter((m) => !prices.has(m));
      if (still.length) {
        const dex = await fetchDexInfo(still).catch(() => new Map());
        for (const [mint, d] of dex) if (d.priceNative > 0) prices.set(mint, d.priceNative);
      }
    }
    const now = Date.now();
    for (const [mint, p] of prices) {
      const t = this.tracker.tokens.get(mint);
      if (t) addPrice(t, { t: now, priceSol: p });
    }
    return prices;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = this.open().filter((r) => r.status === 'open');
      if (!rows.length) {
        if (this.subs.size) this.syncSubscriptions();
        return;
      }
      const prices = await this.fetchPrices(rows);
      const now = Date.now();
      for (const r of rows) this.handlePrice(r, prices.get(r.mint) ?? null, now);
      this.syncSubscriptions();
    } catch (e) {
      logger.warn({ err: String(e) }, 'positiemonitor fout');
    } finally {
      this.busy = false;
    }
  }

  /** Verkoopt een positie. Bij een fout blijft de positie open met `pending_exit` en wordt het later opnieuw geprobeerd. */
  async sell(id: number, reason: ExitReason): Promise<boolean> {
    if (this.selling.has(id)) return false;
    const r = this.get(id);
    if (!r || r.status === 'closed') return false;
    this.selling.add(id);
    this.db.prepare("UPDATE positions SET status = 'closing', pending_exit = ? WHERE id = ?").run(reason, id);
    const s = this.settings().general;
    try {
      const exec = this.executorFor(r.mode);
      if (!exec) throw new Error(`geen ${r.mode} executor beschikbaar (wallet ontbreekt?)`);
      const fill = await exec.sell({
        mint: r.mint,
        tokenAmountRaw: BigInt(r.token_amount_raw),
        decimals: r.decimals,
        // Bij herhaalde mislukte verkoop: meer slippage toestaan
        slippagePct: Math.min(50, s.slippagePct + r.sell_attempts * 5),
        priorityFeeSol: s.priorityFeeSol,
      });
      const ui = tokensUi(r);
      const pnlSol = fill.solAmount - r.entry_sol;
      const pnlPct = r.entry_sol > 0 ? (pnlSol / r.entry_sol) * 100 : 0;
      this.db
        .prepare(
          `UPDATE positions SET status = 'closed', closed_at = ?, exit_sol = ?, exit_price_sol = ?, exit_reason = ?, pnl_sol = ?, pnl_pct = ?,
            sell_sig = ?, pending_exit = NULL, last_error = NULL WHERE id = ?`,
        )
        .run(Date.now(), fill.solAmount, ui > 0 ? fill.solAmount / ui : 0, reason, pnlSol, pnlPct, fill.signature ?? null, id);
      this.tracker.pinned.delete(r.mint);
      logger.info({ id, symbol: r.symbol, mode: r.mode, reason, pnlSol: +pnlSol.toFixed(5), pnlPct: +pnlPct.toFixed(1), sig: fill.signature }, 'positie gesloten');
      return true;
    } catch (e) {
      const attempts = r.sell_attempts + 1;
      const delay = Math.min(60_000, 5_000 * 2 ** Math.min(attempts - 1, 4));
      this.db
        .prepare("UPDATE positions SET status = 'open', sell_attempts = ?, next_sell_at = ?, last_error = ? WHERE id = ?")
        .run(attempts, Date.now() + delay, String(e instanceof Error ? e.message : e).slice(0, 500), id);
      logger.error({ id, symbol: r.symbol, attempts, retryInS: delay / 1000, err: String(e) }, 'verkoop mislukt, failsafe probeert opnieuw');
      return false;
    } finally {
      this.selling.delete(id);
    }
  }

  async sellAll(): Promise<void> {
    const rows = this.open();
    logger.warn({ count: rows.length }, 'SELL ALL');
    await Promise.all(rows.map((r) => this.sell(r.id, 'SELL_ALL')));
  }

  views(now = Date.now()): OpenPositionView[] {
    return this.open().map((r) => {
      const valueSol = r.last_price_sol !== null ? tokensUi(r) * r.last_price_sol : null;
      const livePnlSol = valueSol !== null ? valueSol - r.entry_sol : null;
      return {
        ...r,
        valueSol,
        livePnlSol,
        livePnlPct: livePnlSol !== null && r.entry_sol > 0 ? (livePnlSol / r.entry_sol) * 100 : null,
        heldMin: (now - r.opened_at) / 60_000,
      };
    });
  }

  closed(opts: { mode?: string; from?: number; limit?: number } = {}): PositionRow[] {
    const where = ["status = 'closed'"];
    const args: (string | number)[] = [];
    if (opts.mode && opts.mode !== 'all') {
      where.push('mode = ?');
      args.push(opts.mode);
    }
    if (opts.from) {
      where.push('closed_at >= ?');
      args.push(opts.from);
    }
    const sql = `SELECT * FROM positions WHERE ${where.join(' AND ')} ORDER BY closed_at DESC${opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : ''}`;
    return this.db.prepare(sql).all(...args) as unknown as PositionRow[];
  }

  /**
   * Reset statistieken: gesloten trades krijgen status 'archived'. Ze tellen niet meer mee
   * in statistieken/grafieken, maar blijven bewaard (en voorkomen dubbele aankopen).
   */
  archiveClosed(mode: string): number {
    const sql = mode === 'all' ? "UPDATE positions SET status = 'archived' WHERE status = 'closed'" : "UPDATE positions SET status = 'archived' WHERE status = 'closed' AND mode = ?";
    const res = mode === 'all' ? this.db.prepare(sql).run() : this.db.prepare(sql).run(mode);
    return Number(res.changes);
  }

  realizedSince(from: number, mode: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(pnl_sol), 0) AS s FROM positions WHERE status = 'closed' AND closed_at >= ? AND mode = ?")
      .get(from, mode) as { s: number };
    return row.s;
  }
}
