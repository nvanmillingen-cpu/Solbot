import type { Connection } from '@solana/web3.js';
import type { Db } from '../db.js';
import type { Executor, Fill } from '../executor/types.js';
import { logger, runId, shouldLog } from '../logger.js';
import { bondingCurvePda, curvePriceSol, decodeCurve, fetchCurves } from '../market/bondingCurve.js';
import { fetchDexInfo } from '../market/dexscreener.js';
import { jupPricesUsd } from '../market/jupiter.js';
import { solUsd } from '../market/solPrice.js';
import type { Settings } from '../settings.js';
import { evaluateExit, evaluatePartial, type ExitReason, type PartialExit } from './exits.js';
import { health } from './health.js';
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
  entry_market_price_sol: number | null;
  exit_trigger_price_sol: number | null;
  peak_price_at: number | null;
  min_price_sol: number | null;
  min_price_at: number | null;
  post_max_price_sol: number | null;
  post_max_at: number | null;
  post_min_price_sol: number | null;
  post_min_at: number | null;
  post_graduated: number | null;
  post_watch_until: number | null;
  config_hash: string | null;
  run_id: string | null;
  tokens_sold_raw: string;
  realized_sol: number;
  partial_done: string;
  entry_age_min: number | null;
  entry_mcap_usd: number | null;
  entry_vol_total_usd: number | null;
  entry_vol10m_usd: number | null;
  entry_price_change_pct: number | null;
  entry_holders: number | null;
  entry_top10_pct: number | null;
  entry_creator_pct: number | null;
  entry_rt_loss_pct: number | null;
}

/** Tokendata op het moment van aankoop (voor analyse per trade). */
export interface EntryInfo {
  ageMin: number | null;
  mcapUsd: number | null;
  volTotalUsd: number | null;
  vol10mUsd: number | null;
  priceChangePct: number | null;
  holders: number | null;
  top10Pct: number | null;
  creatorPct: number | null;
  rtLossPct: number | null;
}

export interface OpenPositionView extends PositionRow {
  valueSol: number | null;
  livePnlSol: number | null;
  livePnlPct: number | null;
  heldMin: number;
  /** Geen verse prijs: exit-regels kunnen nu niet (op tijd) vuren. */
  unmonitored: boolean;
  /** Leeftijd van de laatste prijs in seconden. */
  priceAgeS: number | null;
}

/** Zonder prijs langer dan dit geldt een positie als onbewaakt. */
const UNMONITORED_MS = 15_000;

const pctOf = (price: number | null, ref: number | null) => (price !== null && ref ? +((price / ref - 1) * 100).toFixed(1) : null);

/** Nog niet verkochte tokens (ruw). */
export function remainingRaw(p: Pick<PositionRow, 'token_amount_raw' | 'tokens_sold_raw'>): bigint {
  const rest = BigInt(p.token_amount_raw) - BigInt(p.tokens_sold_raw || '0');
  return rest > 0n ? rest : 0n;
}

/** Nog niet verkochte tokens (hele tokens). */
export function tokensUi(p: Pick<PositionRow, 'token_amount_raw' | 'tokens_sold_raw' | 'decimals'>): number {
  return Number(remainingRaw(p)) / 10 ** p.decimals;
}

const r2 = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? null : +n.toFixed(d));

/** Aankoopdata als logvelden. */
function entryFields(r: PositionRow) {
  return {
    leeftijdMin: r2(r.entry_age_min),
    mcapUsd: r2(r.entry_mcap_usd, 0),
    volTotaalUsd: r2(r.entry_vol_total_usd, 0),
    vol10mUsd: r2(r.entry_vol10m_usd, 0),
    stijgingPct: r2(r.entry_price_change_pct),
    holders: r.entry_holders,
    top10Pct: r2(r.entry_top10_pct),
    makerPct: r2(r.entry_creator_pct),
  };
}

/** Houdt posities bij in SQLite en bewaakt exit-regels. */
export class PositionManager {
  private selling = new Set<number>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  /** mint → websocket-subscriptie op de bonding curve (realtime prijs). */
  private subs = new Map<string, number>();
  private lastExternalFetch = 0;
  /** Gesloten posities waarvan de prijs na de exit nog gevolgd wordt (voor de samenvatting aan het eind). */
  private watching = new Map<number, string>();
  /** Na een mislukte deelverkoop: niet vóór dit tijdstip opnieuw proberen. */
  private partialRetryAt = new Map<number, number>();

  constructor(
    private db: Db,
    private conn: Connection,
    private tracker: TokenTracker,
    private settings: () => Settings,
    private executorFor: (mode: 'paper' | 'live') => Executor | null,
  ) {
    // Posities die midden in een verkoop zaten bij een crash weer openzetten
    db.prepare("UPDATE positions SET status = 'open' WHERE status = 'closing'").run();
    for (const p of [...this.open(), ...this.watched()]) {
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
              if (c.complete) this.tracker.markGraduated(t, 'positie');
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
    // Rij kan verouderd zijn (opgehaald vóór een await): alleen echt open posities verwerken
    if (this.status(r.id) !== 'open') return;
    if (price !== null) {
      if (price > r.peak_price_sol) Object.assign(r, { peak_price_sol: price, peak_price_at: now });
      if (r.min_price_sol === null || price < r.min_price_sol) Object.assign(r, { min_price_sol: price, min_price_at: now });
      this.db
        .prepare('UPDATE positions SET last_price_sol = ?, last_price_at = ?, peak_price_sol = ?, peak_price_at = ?, min_price_sol = ?, min_price_at = ? WHERE id = ?')
        .run(price, now, r.peak_price_sol, r.peak_price_at, r.min_price_sol, r.min_price_at, r.id);
    }
    // Eerder getriggerde exit die mislukte: opnieuw proberen (failsafe)
    if (r.pending_exit) {
      if (!r.next_sell_at || now >= r.next_sell_at) void this.sell(r.id, r.pending_exit, price ?? undefined);
      return;
    }
    const exits = this.settings().exits;
    const reason = evaluateExit({ entryPriceSol: r.entry_price_sol, peakPriceSol: r.peak_price_sol, openedAt: r.opened_at }, price, now, exits);
    // Deelverkopen (inzet eruit / deel take-profit) gaan vóór de volledige take-profit; SL, trailing en tijd gaan altijd voor
    if (!reason || reason === 'TP') {
      const partial = evaluatePartial(
        { entryPriceSol: r.entry_price_sol, entrySol: r.entry_sol, realizedSol: r.realized_sol, remainingTokens: tokensUi(r), done: r.partial_done ? r.partial_done.split(',') : [] },
        price,
        exits,
      );
      if (partial && now >= (this.partialRetryAt.get(r.id) ?? 0)) {
        void this.sellPartial(r.id, partial, price!);
        return;
      }
    }
    if (reason) {
      logger.info({ id: r.id, symbol: r.symbol, reason, price, entry: r.entry_price_sol }, 'exit-regel geraakt');
      void this.sell(r.id, reason, price ?? undefined);
    }
  }

  open(): PositionRow[] {
    return this.db.prepare("SELECT * FROM positions WHERE status IN ('open','closing') ORDER BY opened_at").all() as unknown as PositionRow[];
  }

  /** Gesloten posities waarvan de prijs na de exit nog gevolgd wordt. */
  watched(now = Date.now()): PositionRow[] {
    return this.db.prepare("SELECT * FROM positions WHERE status IN ('closed','archived') AND post_watch_until > ?").all(now) as unknown as PositionRow[];
  }

  private status(id: number): string | undefined {
    return (this.db.prepare('SELECT status FROM positions WHERE id = ?').get(id) as { status: string } | undefined)?.status;
  }

  get(id: number): PositionRow | undefined {
    return this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as unknown as PositionRow | undefined;
  }

  everBought(mint: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM positions WHERE mint = ? LIMIT 1').get(mint));
  }

  record(p: { mint: string; symbol: string; name: string; mode: 'paper' | 'live'; fill: Fill; graduated: boolean; configHash?: string; entry?: EntryInfo }): PositionRow {
    const ui = Number(p.fill.tokenAmountRaw) / 10 ** p.fill.decimals;
    const entryPrice = ui > 0 ? p.fill.solAmount / ui : 0;
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO positions (mint, symbol, name, mode, status, executor, entry_sol, token_amount_raw, decimals, entry_price_sol,
          opened_at, peak_price_sol, last_price_sol, last_price_at, buy_sig, graduated, entry_market_price_sol,
          peak_price_at, min_price_sol, min_price_at, config_hash, run_id,
          entry_age_min, entry_mcap_usd, entry_vol_total_usd, entry_vol10m_usd, entry_price_change_pct,
          entry_holders, entry_top10_pct, entry_creator_pct, entry_rt_loss_pct)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        p.fill.marketPriceSol ?? null,
        now,
        entryPrice,
        now,
        p.configHash ?? null,
        runId,
        p.entry?.ageMin ?? null,
        p.entry?.mcapUsd ?? null,
        p.entry?.volTotalUsd ?? null,
        p.entry?.vol10mUsd ?? null,
        p.entry?.priceChangePct ?? null,
        p.entry?.holders ?? null,
        p.entry?.top10Pct ?? null,
        p.entry?.creatorPct ?? null,
        p.entry?.rtLossPct ?? null,
      );
    if (p.fill.marketPriceSol && entryPrice > 0) {
      const dev = (entryPrice / p.fill.marketPriceSol - 1) * 100;
      // Effectieve instapprijs hoort ~1-3% boven de marktprijs te liggen (fees + impact)
      if (Math.abs(dev) > 15) logger.warn({ mint: p.mint, entryPrice, market: p.fill.marketPriceSol, devPct: dev.toFixed(1) }, 'instapprijs wijkt sterk af van de marktprijs bij besluit (fill-fout of koersbeweging tijdens de landingsvertraging)');
    }
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
          if (c.complete) this.tracker.markGraduated(t, 'positie');
        }
        if (!c.complete) prices.set(mint, curvePriceSol(c));
      }
      if (onCurve.length) health.ok('positiePrijzen');
    } catch (e) {
      health.fail('positiePrijzen', e);
      const l = shouldLog('positie-prijzen');
      if (l.ok) logger.warn({ err: String(e).slice(0, 200), overgeslagen: l.suppressed }, 'prijzen open posities niet op te halen (RPC)');
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
      const watched = this.watched();
      this.finishWatches(watched);
      if (!rows.length && !watched.length) {
        if (this.subs.size) this.syncSubscriptions();
        return;
      }
      const prices = await this.fetchPrices([...rows, ...watched]);
      const now = Date.now();
      for (const r of rows) this.handlePrice(r, prices.get(r.mint) ?? null, now);
      for (const w of watched) this.handlePostExit(w, prices.get(w.mint) ?? null, now);
      this.syncSubscriptions();
    } catch (e) {
      logger.warn({ err: String(e) }, 'positiemonitor fout');
    } finally {
      this.busy = false;
    }
  }

  /** Na de exit: hoogste/laagste prijs en graduation bijhouden (MFE/MAE na exit). */
  private handlePostExit(w: PositionRow, price: number | null, now: number) {
    this.watching.set(w.id, w.mint);
    const graduated = this.tracker.tokens.get(w.mint)?.graduated ?? false;
    if (graduated && !w.post_graduated) {
      this.db.prepare('UPDATE positions SET post_graduated = 1 WHERE id = ?').run(w.id);
      logger.info({ id: w.id, symbol: w.symbol, exitReason: w.exit_reason, naExitMin: +((now - (w.closed_at ?? now)) / 60_000).toFixed(1) }, 'token gegradueerd ná onze exit');
    }
    if (price === null) return;
    if (w.post_max_price_sol === null || price > w.post_max_price_sol) {
      this.db.prepare('UPDATE positions SET post_max_price_sol = ?, post_max_at = ? WHERE id = ?').run(price, now, w.id);
    }
    if (w.post_min_price_sol === null || price < w.post_min_price_sol) {
      this.db.prepare('UPDATE positions SET post_min_price_sol = ?, post_min_at = ? WHERE id = ?').run(price, now, w.id);
    }
  }

  /** Volgvenster na exit afgelopen: samenvatting loggen en het token weer vrijgeven. */
  private finishWatches(stillWatched: PositionRow[]) {
    const active = new Set(stillWatched.map((w) => w.id));
    for (const [id, mint] of this.watching) {
      if (active.has(id)) continue;
      this.watching.delete(id);
      if (!this.open().some((r) => r.mint === mint) && !stillWatched.some((w) => w.mint === mint)) this.tracker.pinned.delete(mint);
      const r = this.get(id);
      if (!r) continue;
      logger.info(
        {
          id,
          symbol: r.symbol,
          exitReason: r.exit_reason,
          pnlPct: r.pnl_pct === null ? null : +r.pnl_pct.toFixed(1),
          maxTijdensPct: pctOf(r.peak_price_sol, r.entry_price_sol),
          minTijdensPct: pctOf(r.min_price_sol, r.entry_price_sol),
          maxNaExitVsInstapPct: pctOf(r.post_max_price_sol, r.entry_price_sol),
          minNaExitVsInstapPct: pctOf(r.post_min_price_sol, r.entry_price_sol),
          maxNaExitVsExitPct: pctOf(r.post_max_price_sol, r.exit_price_sol),
          gegradueerdNaExit: Boolean(r.post_graduated),
        },
        'na-exit analyse (MFE/MAE)',
      );
    }
  }

  /**
   * Gedeeltelijke verkoop (inzet eruit / deel take-profit). Gebruikt dezelfde closing-lock als een
   * volledige verkoop; daarna gaat de positie weer op 'open' met minder tokens. Bijna alles
   * verkopen (≥ 98%) wordt een gewone volledige verkoop.
   */
  async sellPartial(id: number, pe: PartialExit, triggerPriceSol: number): Promise<boolean> {
    if (this.selling.has(id)) return false;
    const r = this.get(id);
    if (!r || r.status !== 'open') return false;
    const rest = remainingRaw(r);
    const amount = (rest * BigInt(Math.floor(pe.fraction * 10_000))) / 10_000n;
    if (pe.fraction >= 0.98 || amount >= rest) return this.sell(id, pe.kind, triggerPriceSol);
    if (amount <= 0n) {
      // Niets te verkopen (bijv. inleg al terug uit eerdere deelverkopen): niveau alleen afvinken
      const done = [...(r.partial_done ? r.partial_done.split(',') : []), pe.key].join(',');
      this.db.prepare("UPDATE positions SET partial_done = ? WHERE id = ? AND status = 'open'").run(done, id);
      logger.info({ id, symbol: r.symbol, niveau: pe.key }, 'niveau afgevinkt zonder verkoop (inleg al terug)');
      return true;
    }
    const lock = this.db.prepare("UPDATE positions SET status = 'closing' WHERE id = ? AND status = 'open'").run(id);
    if (Number(lock.changes) !== 1) return false;
    this.selling.add(id);
    const s = this.settings().general;
    const pnlAtTrigger = (triggerPriceSol / r.entry_price_sol - 1) * 100;
    try {
      const exec = this.executorFor(r.mode);
      if (!exec) throw new Error(`geen ${r.mode} executor beschikbaar (wallet ontbreekt?)`);
      const fill = await exec.sell({ mint: r.mint, tokenAmountRaw: amount, decimals: r.decimals, slippagePct: s.slippagePct, priorityFeeSol: s.priorityFeeSol });
      const sold = fill.tokenAmountRaw > 0n && fill.tokenAmountRaw <= rest ? fill.tokenAmountRaw : amount;
      const soldUi = Number(sold) / 10 ** r.decimals;
      const done = [...(r.partial_done ? r.partial_done.split(',') : []), pe.key].join(',');
      const totalSold = BigInt(r.tokens_sold_raw || '0') + sold;
      const realized = r.realized_sol + fill.solAmount;
      this.db
        .prepare("UPDATE positions SET status = 'open', tokens_sold_raw = ?, realized_sol = ?, partial_done = ? WHERE id = ?")
        .run(totalSold.toString(), realized, done, id);
      this.db
        .prepare('INSERT INTO position_sells (position_id, at, kind, level_key, tokens_raw, sol, price_sol, trigger_price_sol, pnl_pct_at_trigger, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, Date.now(), pe.kind, pe.key, sold.toString(), fill.solAmount, soldUi > 0 ? fill.solAmount / soldUi : null, triggerPriceSol, pnlAtTrigger, fill.signature ?? null);
      this.partialRetryAt.delete(id);
      logger.info(
        {
          id,
          symbol: r.symbol,
          soort: pe.kind === 'INIT' ? 'inzet eruit' : 'deel take-profit',
          niveau: pe.key,
          winstPct: +pnlAtTrigger.toFixed(1),
          verkochtPct: +((Number(sold) / Number(BigInt(r.token_amount_raw))) * 100).toFixed(1),
          ontvangenSol: +fill.solAmount.toFixed(5),
          totaalTerugSol: +realized.toFixed(5),
          inlegSol: +r.entry_sol.toFixed(5),
          restPct: +((Number(rest - sold) / Number(BigInt(r.token_amount_raw))) * 100).toFixed(1),
          via: fill.executor,
          sig: fill.signature,
        },
        'deelverkoop uitgevoerd',
      );
      return true;
    } catch (e) {
      this.db.prepare("UPDATE positions SET status = 'open' WHERE id = ?").run(id);
      this.partialRetryAt.set(id, Date.now() + 10_000);
      logger.error({ id, symbol: r.symbol, niveau: pe.key, err: String(e).slice(0, 300) }, 'deelverkoop mislukt, over 10 s opnieuw');
      return false;
    } finally {
      this.selling.delete(id);
    }
  }

  /** Verkoopt een positie. Bij een fout blijft de positie open met `pending_exit` en wordt het later opnieuw geprobeerd. */
  async sell(id: number, reason: ExitReason, triggerPriceSol?: number): Promise<boolean> {
    if (this.selling.has(id)) return false;
    const r = this.get(id);
    if (!r || r.status !== 'open') return false;
    const trigger = triggerPriceSol ?? r.exit_trigger_price_sol ?? r.last_price_sol ?? null;
    // Closing-lock: alleen de aanroep die de status van 'open' naar 'closing' zet, mag verkopen.
    // Zo kan een tweede exit-trigger (poll + websocket tegelijk) nooit een dubbele verkoop starten.
    const lock = this.db
      .prepare("UPDATE positions SET status = 'closing', pending_exit = ?, exit_trigger_price_sol = COALESCE(exit_trigger_price_sol, ?) WHERE id = ? AND status = 'open'")
      .run(reason, trigger, id);
    if (Number(lock.changes) !== 1) return false;
    this.selling.add(id);
    const s = this.settings().general;
    try {
      const exec = this.executorFor(r.mode);
      if (!exec) throw new Error(`geen ${r.mode} executor beschikbaar (wallet ontbreekt?)`);
      const fill = await exec.sell({
        mint: r.mint,
        tokenAmountRaw: remainingRaw(r),
        decimals: r.decimals,
        // Bij herhaalde mislukte verkoop: meer slippage toestaan
        slippagePct: Math.min(50, s.slippagePct + r.sell_attempts * 5),
        priorityFeeSol: s.priorityFeeSol,
      });
      const ui = tokensUi(r);
      const fillPrice = ui > 0 ? fill.solAmount / ui : 0;
      // Slippage tussen trigger en werkelijke verkoop (bij een dump kan dit groot zijn)
      const slippagePct = trigger ? (fillPrice / trigger - 1) * 100 : null;
      if (slippagePct !== null && slippagePct < -15) {
        logger.warn({ id, symbol: r.symbol, trigger, fillPrice, market: fill.marketPriceSol, slippagePct: slippagePct.toFixed(1) }, 'grote slippage tussen exit-trigger en verkoop');
      }
      // Totale opbrengst = eerdere deelverkopen + deze eindverkoop
      const exitSol = r.realized_sol + fill.solAmount;
      const pnlSol = exitSol - r.entry_sol;
      const closedAt = Date.now();
      const watchMin = this.settings().tracker.postExitWatchMin;
      const pnlPct = r.entry_sol > 0 ? (pnlSol / r.entry_sol) * 100 : 0;
      this.db
        .prepare(
          `UPDATE positions SET status = 'closed', closed_at = ?, exit_sol = ?, exit_price_sol = ?, exit_reason = ?, pnl_sol = ?, pnl_pct = ?,
            sell_sig = ?, pending_exit = NULL, last_error = NULL, post_watch_until = ?, post_graduated = 0 WHERE id = ?`,
        )
        .run(closedAt, exitSol, fillPrice, reason, pnlSol, pnlPct, fill.signature ?? null, watchMin > 0 ? closedAt + watchMin * 60_000 : null, id);
      this.db
        .prepare('INSERT INTO position_sells (position_id, at, kind, level_key, tokens_raw, sol, price_sol, trigger_price_sol, pnl_pct_at_trigger, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, closedAt, reason, null, remainingRaw(r).toString(), fill.solAmount, fillPrice || null, trigger, trigger ? (trigger / r.entry_price_sol - 1) * 100 : null, fill.signature ?? null);
      // Token blijft gevolgd zolang het na-exit-venster loopt
      if (watchMin <= 0) this.tracker.pinned.delete(r.mint);
      logger.info(
        {
          id,
          symbol: r.symbol,
          mode: r.mode,
          reason,
          pnlSol: +pnlSol.toFixed(5),
          pnlPct: +pnlPct.toFixed(1),
          slippagePct: slippagePct?.toFixed(1),
          houdtijdS: +((closedAt - r.opened_at) / 1000).toFixed(1),
          maxTijdensPct: pctOf(r.peak_price_sol, r.entry_price_sol),
          minTijdensPct: pctOf(r.min_price_sol, r.entry_price_sol),
          config: r.config_hash,
          deelverkopen: r.partial_done || null,
          uitDeelverkopenSol: r.realized_sol ? +r.realized_sol.toFixed(5) : null,
          ...entryFields(r),
          via: fill.executor,
          sig: fill.signature,
        },
        'positie gesloten',
      );
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
    const rows = this.open().filter((r) => r.status === 'open');
    logger.warn({ count: rows.length }, 'SELL ALL');
    await Promise.all(rows.map((r) => this.sell(r.id, 'SELL_ALL')));
  }

  views(now = Date.now()): OpenPositionView[] {
    return this.open().map((r) => {
      const valueSol = r.last_price_sol !== null ? tokensUi(r) * r.last_price_sol + r.realized_sol : null;
      const livePnlSol = valueSol !== null ? valueSol - r.entry_sol : null;
      return {
        ...r,
        valueSol,
        livePnlSol,
        livePnlPct: livePnlSol !== null && r.entry_sol > 0 ? (livePnlSol / r.entry_sol) * 100 : null,
        heldMin: (now - r.opened_at) / 60_000,
        unmonitored: r.last_price_at === null || now - r.last_price_at > UNMONITORED_MS || health.isDown('positiePrijzen'),
        priceAgeS: r.last_price_at === null ? null : Math.round((now - r.last_price_at) / 1000),
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

  /** Aantal gesloten trades met deze config-hash (ook gearchiveerde): pas vergelijken vanaf ~200–300 trades. */
  countWithConfig(hash: string, mode: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM positions WHERE config_hash = ? AND mode = ? AND status IN ('closed','archived')").get(hash, mode) as { n: number };
    return row.n;
  }

  /**
   * Alle trades (ook gearchiveerde) voor export/analyse, met afgeleide kolommen in %:
   * MFE/MAE tijdens het houden (max_/min_tijdens) en ná de exit, t.o.v. instap- en exitprijs.
   */
  allForExport(): Record<string, unknown>[] {
    const pct = (a: string, b: string) => `ROUND((${a} / NULLIF(${b}, 0) - 1) * 100, 2)`;
    const local = (c: string) => `strftime('%Y-%m-%d %H:%M:%S', ${c} / 1000, 'unixepoch', 'localtime')`;
    return this.db
      .prepare(
        `SELECT id, run_id, config_hash, mode, status, mint, symbol, executor,
          ${local('opened_at')} AS geopend, ${local('closed_at')} AS gesloten,
          ROUND((closed_at - opened_at) / 1000.0, 1) AS houdtijd_s,
          exit_reason, entry_sol, exit_sol, ROUND(pnl_sol, 6) AS pnl_sol, ROUND(pnl_pct, 2) AS pnl_pct,
          partial_done AS deelverkopen, ROUND(realized_sol, 6) AS uit_deelverkopen_sol,
          ROUND(entry_age_min, 2) AS leeftijd_min, ROUND(entry_mcap_usd) AS mcap_usd,
          ROUND(entry_vol_total_usd) AS volume_totaal_usd, ROUND(entry_vol10m_usd) AS volume_10m_usd,
          ROUND(entry_price_change_pct, 1) AS stijging_pct, entry_holders AS holders,
          ROUND(entry_top10_pct, 1) AS top10_pct, ROUND(entry_creator_pct, 1) AS maker_pct,
          ROUND(entry_rt_loss_pct, 2) AS round_trip_verlies_pct,
          ${pct('entry_price_sol', 'entry_market_price_sol')} AS instap_vs_markt_pct,
          ${pct('exit_price_sol', 'exit_trigger_price_sol')} AS exit_slippage_pct,
          ${pct('peak_price_sol', 'entry_price_sol')} AS max_tijdens_pct,
          ROUND((peak_price_at - opened_at) / 1000.0, 1) AS max_tijdens_na_s,
          ${pct('min_price_sol', 'entry_price_sol')} AS min_tijdens_pct,
          ROUND((min_price_at - opened_at) / 1000.0, 1) AS min_tijdens_na_s,
          ${pct('post_max_price_sol', 'entry_price_sol')} AS max_na_exit_vs_instap_pct,
          ${pct('post_max_price_sol', 'exit_price_sol')} AS max_na_exit_vs_exit_pct,
          ROUND((post_max_at - closed_at) / 60000.0, 1) AS max_na_exit_na_min,
          ${pct('post_min_price_sol', 'entry_price_sol')} AS min_na_exit_vs_instap_pct,
          ${pct('post_min_price_sol', 'exit_price_sol')} AS min_na_exit_vs_exit_pct,
          post_graduated AS gegradueerd_na_exit,
          entry_price_sol, entry_market_price_sol, exit_trigger_price_sol, exit_price_sol,
          peak_price_sol, min_price_sol, post_max_price_sol, post_min_price_sol, buy_sig, sell_sig
        FROM positions ORDER BY opened_at`,
      )
      .all() as Record<string, unknown>[];
  }

  realizedSince(from: number, mode: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(pnl_sol), 0) AS s FROM positions WHERE status = 'closed' AND closed_at >= ? AND mode = ?")
      .get(from, mode) as { s: number };
    return row.s;
  }
}
