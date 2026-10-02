import { PublicKey, type Connection } from '@solana/web3.js';
import { logger } from '../logger.js';
import type { PumpPortalFeed, NewTokenEvent, TradeEvent, MigrationEvent } from '../feed/pumpportal.js';
import { RpcLogFeed } from '../feed/rpcLogs.js';
import { curvePriceSol, fetchCurves } from '../market/bondingCurve.js';
import { fetchDexInfo } from '../market/dexscreener.js';
import { solUsdCached } from '../market/solPrice.js';
import type { Settings } from '../settings.js';
import { addPrice, computeMetrics, newTrackedToken, type TokenMetrics, type TrackedToken } from './metrics.js';

/**
 * Volgt nieuwe (en gemigreerde) tokens en houdt per token prijs-, volume- en
 * curve-data bij uit gratis bronnen: PumpPortal, on-chain bonding curve en DexScreener.
 */
export class TokenTracker {
  readonly tokens = new Map<string, TrackedToken>();
  /** Mints die niet opgeruimd mogen worden (open posities). */
  readonly pinned = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  readonly rpcFeed: RpcLogFeed;
  private startedAt = Date.now();
  private curveBusy = false;
  private dexBusy = false;
  private lastHoldersWarn = 0;
  stats = { rpcFeedTokens: 0, newTokens: 0, migrations: 0, curvePolls: 0, dexPolls: 0, lastCurvePollAt: 0, lastDexPollAt: 0, errors: 0 };

  constructor(
    private conn: Connection,
    private feed: PumpPortalFeed,
    private settings: () => Settings,
  ) {
    feed.on('newToken', (e: NewTokenEvent) => this.onNewToken(e));
    // Fallback: als PumpPortal 60 s geen nieuwe tokens levert, ook de RPC-logs gebruiken
    this.rpcFeed = new RpcLogFeed(conn);
    this.rpcFeed.on('newToken', (e: NewTokenEvent) => this.onNewToken(e));
    feed.on('trade', (e: TradeEvent) => this.onTrade(e));
    feed.on('migration', (e: MigrationEvent) => this.onMigration(e));
  }

  start() {
    this.stop();
    const s = this.settings().tracker;
    this.timers.push(setInterval(() => void this.pollCurves(), s.curvePollSec * 1000));
    this.timers.push(setInterval(() => void this.pollDex(), s.dexPollSec * 1000));
    this.timers.push(setInterval(() => this.prune(), 30_000));
    this.timers.push(setInterval(() => this.checkFeed(), 10_000));
  }

  /** Herstart timers na een instellingswijziging. */
  restart() {
    this.start();
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  private checkFeed() {
    const last = Math.max(this.feed.lastNewTokenAt, this.startedAt);
    if (!this.rpcFeed.active && Date.now() - last > 60_000) {
      logger.warn('PumpPortal levert al 60 s geen nieuwe tokens');
      this.rpcFeed.start();
    }
  }

  private onNewToken(e: NewTokenEvent) {
    // Alleen pump.fun (PumpPortal streamt ook o.a. letsbonk-tokens)
    if (e.pool !== 'pump') return;
    if (this.tokens.has(e.mint)) return;
    this.stats.newTokens++;
    if (e.source === 'rpc') this.stats.rpcFeedTokens++;
    const launchPrice = e.vTokensInBondingCurve > 0 ? e.vSolInBondingCurve / e.vTokensInBondingCurve : undefined;
    const t = newTrackedToken({
      mint: e.mint,
      source: 'new',
      name: e.name,
      symbol: e.symbol,
      creator: e.creator,
      firstSeenAt: e.receivedAt,
      createdAt: e.receivedAt,
      initialBuySol: e.initialBuySol,
      launchPriceSol: launchPrice,
      mayhem: e.mayhem,
      tradeStream: this.feed.tradesAvailable && e.source === 'pumpportal',
    });
    if (launchPrice) addPrice(t, { t: e.receivedAt, priceSol: launchPrice });
    if (t.tradeStream && e.creator && e.initialBuySol > 0) t.balances.set(e.creator, e.initialBuyTokens || 1);
    this.tokens.set(e.mint, t);
    if (e.source === 'pumpportal') this.feed.subscribeTrades([e.mint]);
    this.enforceMax();
  }

  private onTrade(e: TradeEvent) {
    const t = this.tokens.get(e.mint);
    if (!t) return;
    t.trades.push({ t: e.receivedAt, sol: e.solAmount });
    if (t.trades.length > 5000) t.trades.splice(0, t.trades.length - 5000);
    const bal = (t.balances.get(e.trader) ?? 0) + (e.isBuy ? e.tokenAmount : -e.tokenAmount);
    t.balances.set(e.trader, bal > 1e-6 ? bal : 0);
    if (e.vSolInBondingCurve && e.vTokensInBondingCurve) {
      addPrice(t, { t: e.receivedAt, priceSol: e.vSolInBondingCurve / e.vTokensInBondingCurve });
    }
  }

  private onMigration(e: MigrationEvent) {
    if (e.pool && !e.pool.startsWith('pump')) return;
    this.stats.migrations++;
    const t = this.tokens.get(e.mint);
    if (t) {
      t.graduated = true;
      logger.info({ mint: e.mint, symbol: t.symbol }, 'token gegradueerd');
      return;
    }
    // Gemigreerde tokens ook volgen (voor het filter graduated = ja)
    if (this.settings().filters.graduated === 'no') return;
    this.tokens.set(e.mint, newTrackedToken({ mint: e.mint, source: 'migration', graduated: true, firstSeenAt: e.receivedAt }));
    this.enforceMax();
  }

  /** Voeg een token handmatig toe (bijv. voor een open positie na herstart). */
  ensure(mint: string, symbol = '', name = ''): TrackedToken {
    let t = this.tokens.get(mint);
    if (!t) {
      t = newTrackedToken({ mint, source: 'manual', symbol, name });
      this.tokens.set(mint, t);
    }
    return t;
  }

  async pollCurves() {
    if (this.curveBusy) return;
    this.curveBusy = true;
    try {
      const mints = [...this.tokens.values()].filter((t) => !t.graduated).map((t) => t.mint);
      if (!mints.length) return;
      const curves = await fetchCurves(this.conn, mints);
      const now = Date.now();
      for (const [mint, c] of curves) {
        const t = this.tokens.get(mint);
        if (!t) continue;
        if (t.curve) {
          const delta = Math.abs(Number(c.realSolReserves - t.curve.realSolReserves)) / 1e9;
          if (delta > 0) t.curveVolume.push({ t: now, sol: delta });
          if (t.curveVolume.length > 2000) t.curveVolume.splice(0, t.curveVolume.length - 2000);
        }
        t.curve = c;
        t.curveUpdatedAt = now;
        if (c.mayhem) t.mayhem = true;
        if (!t.creator && c.creator) t.creator = c.creator;
        if (!t.launchPriceSol && !t.prices.length) t.launchPriceSol = curvePriceSol(c);
        if (c.complete) {
          if (!t.graduated) logger.info({ mint, symbol: t.symbol }, 'bonding curve voltooid (graduated)');
          t.graduated = true;
        } else {
          addPrice(t, { t: now, priceSol: curvePriceSol(c) });
        }
      }
      this.stats.curvePolls++;
      this.stats.lastCurvePollAt = now;
    } catch (e) {
      this.stats.errors++;
      logger.warn({ err: String(e) }, 'curve-poll mislukt (RPC)');
    } finally {
      this.curveBusy = false;
    }
  }

  async pollDex() {
    if (this.dexBusy) return;
    this.dexBusy = true;
    try {
      // Alleen tokens met activiteit: DexScreener indexeert pas na wat trades
      const list = [...this.tokens.values()].filter(
        (t) => t.graduated || this.pinned.has(t.mint) || t.initialBuySol + t.curveVolume.reduce((s, v) => s + v.sol, 0) >= 1 || t.trades.length >= 5,
      );
      if (!list.length) return;
      const info = await fetchDexInfo(list.map((t) => t.mint));
      const now = Date.now();
      for (const [mint, d] of info) {
        const t = this.tokens.get(mint);
        if (!t) continue;
        t.dex = d;
        if (!t.symbol) t.symbol = mint.slice(0, 6);
        t.dexVolSnapshots.push({ t: now, h24: d.volumeUsd.h24 });
        const cutoff = now - 20 * 60_000;
        while (t.dexVolSnapshots.length && t.dexVolSnapshots[0].t < cutoff) t.dexVolSnapshots.shift();
        // Voor gegradueerde tokens is DexScreener de prijsbron
        if (t.graduated && d.priceNative > 0) addPrice(t, { t: now, priceSol: d.priceNative });
      }
      this.stats.dexPolls++;
      this.stats.lastDexPollAt = now;
    } catch (e) {
      this.stats.errors++;
      logger.warn({ err: String(e) }, 'DexScreener-poll mislukt');
    } finally {
      this.dexBusy = false;
    }
  }

  /** Telt holders via RPC (max 20 grootste accounts → ondergrens). */
  async fetchHolders(mint: string): Promise<void> {
    const t = this.tokens.get(mint);
    if (!t) return;
    if (t.holdersRpc && Date.now() - t.holdersRpc.at < 60_000) return;
    try {
      const res = await this.conn.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
      const nonZero = res.value.filter((a) => Number(a.amount) > 0).length;
      // Het grootste account is de bonding curve / pool zelf
      t.holdersRpc = { count: Math.max(0, nonZero - 1), capped: res.value.length >= 20, at: Date.now() };
    } catch (e) {
      // Publieke RPC's blokkeren getTokenLargestAccounts vaak (429); max. 1 waarschuwing per minuut
      if (Date.now() - this.lastHoldersWarn > 60_000) {
        this.lastHoldersWarn = Date.now();
        logger.warn({ err: String(e).slice(0, 150) }, 'holders niet op te halen via RPC; het holders-filter keurt dan alles af (gebruik een eigen RPC of zet het filter uit)');
      }
    }
  }

  private prune() {
    const { watchWindowMin } = this.settings().tracker;
    const cutoff = Date.now() - watchWindowMin * 60_000;
    const removed: string[] = [];
    for (const [mint, t] of this.tokens) {
      if (this.pinned.has(mint)) continue;
      if (t.firstSeenAt < cutoff) {
        this.tokens.delete(mint);
        removed.push(mint);
      }
    }
    if (removed.length) this.feed.unsubscribeTrades(removed);
  }

  private enforceMax() {
    const max = this.settings().tracker.maxTrackedTokens;
    if (this.tokens.size <= max) return;
    const removed: string[] = [];
    // Map behoudt invoegvolgorde: oudste eerst
    for (const mint of this.tokens.keys()) {
      if (this.tokens.size <= max) break;
      if (this.pinned.has(mint)) continue;
      this.tokens.delete(mint);
      removed.push(mint);
    }
    if (removed.length) this.feed.unsubscribeTrades(removed);
  }

  metrics(mint: string, now = Date.now()): TokenMetrics | undefined {
    const t = this.tokens.get(mint);
    if (!t) return undefined;
    return computeMetrics(t, now, solUsdCached(), this.settings().filters.priceChange.windowMin);
  }

  allMetrics(now = Date.now()): TokenMetrics[] {
    const sol = solUsdCached();
    const win = this.settings().filters.priceChange.windowMin;
    return [...this.tokens.values()].map((t) => computeMetrics(t, now, sol, win));
  }
}
