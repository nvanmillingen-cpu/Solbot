import type { Connection } from '@solana/web3.js';
import { config } from '../config.js';
import { kvGet, kvSet, type Db } from '../db.js';
import type { Executor } from '../executor/types.js';
import { logger } from '../logger.js';
import { solUsd } from '../market/solPrice.js';
import type { SettingsStore } from '../settings.js';
import { solBalance, type Wallet } from '../wallet.js';
import { evaluateFilters, passesExceptHolders, type FilterResult } from './filters.js';
import type { TokenMetrics } from './metrics.js';
import type { PositionManager } from './positions.js';
import { preBuyChecks } from './safety.js';
import { startOfToday } from './stats.js';
import type { TokenTracker } from './tracker.js';

export interface Candidate {
  metrics: TokenMetrics;
  filter: FilterResult;
  status?: string;
}

/** Orchestrator: evalueert kandidaten, bewaakt risicolimieten en koopt. */
export class Bot {
  running = false;
  private timer?: NodeJS.Timeout;
  private evaluating = false;
  /** mint → tijdstip tot wanneer het token overgeslagen wordt (Infinity = permanent). */
  private cooldown = new Map<string, number>();
  private lastBlockReason = '';
  lastCandidates: Candidate[] = [];
  lastEvalAt = 0;
  walletSol: number | null = null;

  constructor(
    private db: Db,
    private conn: Connection,
    private store: SettingsStore,
    private tracker: TokenTracker,
    private positions: PositionManager,
    private wallet: Wallet | null,
    private executorFor: (mode: 'paper' | 'live') => Executor | null,
  ) {
    if (kvGet(db, 'bot_running') === 'true') logger.info('bot stond aan vóór herstart; start bewust opnieuw via het dashboard');
  }

  get mode(): 'paper' | 'live' {
    return this.store.get().general.paperMode ? 'paper' : 'live';
  }

  start() {
    if (this.mode === 'live') {
      if (!config.liveTradingEnabled) throw new Error('live trading is uitgeschakeld (LIVE_TRADING_ENABLED=false in .env)');
      if (!this.wallet) throw new Error('geen geldige PRIVATE_KEY in .env');
    }
    this.running = true;
    kvSet(this.db, 'bot_running', 'true');
    logger.info({ mode: this.mode }, 'bot gestart');
  }

  stop() {
    this.running = false;
    kvSet(this.db, 'bot_running', 'false');
    logger.info('bot gestopt (open posities worden nog wel bewaakt)');
  }

  /** De evaluatielus draait altijd (voor het dashboard); kopen alleen als de bot aan staat. */
  startLoop() {
    this.timer = setInterval(() => void this.evaluate(), 2000);
    setInterval(() => void this.refreshWallet(), 30_000);
    void this.refreshWallet();
  }

  stopLoop() {
    if (this.timer) clearInterval(this.timer);
  }

  async refreshWallet() {
    if (!this.wallet) return;
    try {
      this.walletSol = await solBalance(this.conn, this.wallet.publicKey);
    } catch (e) {
      logger.debug({ err: String(e) }, 'walletbalans ophalen mislukt');
    }
  }

  /** Reden waarom er nu niet gekocht mag worden, of null. */
  buyBlocker(): string | null {
    const s = this.store.get();
    const open = this.positions.open().length;
    if (open >= s.risk.maxOpenPositions) return `max. ${s.risk.maxOpenPositions} posities bereikt`;
    if (s.risk.dailyLossLimit.enabled) {
      const today = this.positions.realizedSince(startOfToday(), this.mode);
      if (today <= -s.risk.dailyLossLimit.sol) return `dagelijks verliesmaximum bereikt (${today.toFixed(3)} SOL)`;
    }
    if (this.mode === 'live') {
      if (!this.wallet) return 'geen wallet';
      if (this.walletSol !== null && this.walletSol < s.risk.solPerTrade + s.risk.minSolReserve + s.general.priorityFeeSol) {
        return `te weinig SOL in wallet (${this.walletSol.toFixed(4)})`;
      }
    }
    return null;
  }

  async evaluate() {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      await solUsd(); // cache verversen
      const s = this.store.get();
      const now = Date.now();
      const all = this.tracker.allMetrics(now);
      const candidates: Candidate[] = [];
      for (const m of all) {
        const filter = evaluateFilters(m, s.filters);
        candidates.push({ metrics: m, filter });
      }
      // Voor dashboard: beste kandidaten eerst (meeste filters gehaald, dan volume)
      const score = (c: Candidate) => c.filter.checks.filter((x) => x.pass).length;
      candidates.sort((a, b) => score(b) - score(a) || (b.metrics.volume10mUsd ?? 0) - (a.metrics.volume10mUsd ?? 0));
      this.lastCandidates = candidates.slice(0, 50);
      this.lastEvalAt = now;
      for (const [mint, until] of this.cooldown) if (until < now || (until === Infinity && !this.tracker.tokens.has(mint))) this.cooldown.delete(mint);

      if (!this.running) return;
      const blocker = this.buyBlocker();
      if (blocker) {
        if (blocker !== this.lastBlockReason) logger.info({ reden: blocker }, 'kopen gepauzeerd');
        this.lastBlockReason = blocker;
        return;
      }
      this.lastBlockReason = '';

      const eligible = candidates.filter((c) => {
        const cd = this.cooldown.get(c.metrics.mint);
        if (cd && cd > now) return false;
        if (this.positions.everBought(c.metrics.mint)) return false;
        return c.filter.pass || (s.filters.minHolders.enabled && passesExceptHolders(c.filter));
      });

      for (const c of eligible) {
        if (!this.running || this.buyBlocker()) break;
        // Holders lui ophalen (kost een RPC-call)
        if (!c.filter.pass) {
          await this.tracker.fetchHolders(c.metrics.mint);
          const m = this.tracker.metrics(c.metrics.mint);
          if (!m) continue;
          c.metrics = m;
          c.filter = evaluateFilters(m, s.filters);
          if (!c.filter.pass) {
            const h = c.filter.checks.find((x) => x.key === 'minHolders');
            logger.info({ symbol: m.symbol, holders: h?.value, nodig: h?.required }, 'afgekeurd op holders');
            this.cooldown.set(m.mint, Date.now() + 60_000);
            continue;
          }
        }
        await this.tryBuy(c);
      }
    } catch (e) {
      logger.warn({ err: String(e) }, 'evaluatie mislukt');
    } finally {
      this.evaluating = false;
    }
  }

  private async tryBuy(c: Candidate) {
    const s = this.store.get();
    const m = c.metrics;
    const mode = this.mode;
    const tracked = this.tracker.tokens.get(m.mint);
    logger.info(
      {
        mint: m.mint,
        symbol: m.symbol,
        mcapUsd: Math.round(m.marketCapUsd ?? 0),
        vol10mUsd: Math.round(m.volume10mUsd ?? 0),
        changePct: m.priceChangePct?.toFixed(1),
      },
      'kandidaat voldoet aan filters, veiligheidscheck',
    );
    const safety = await preBuyChecks(this.conn, s, m, s.risk.solPerTrade, tracked?.curve, tracked?.creator);
    if (!safety.ok) {
      this.cooldown.set(m.mint, safety.permanent ? Infinity : Date.now() + 5 * 60_000);
      logger.info({ symbol: m.symbol, redenen: safety.reasons }, 'veiligheidscheck afgekeurd');
      return;
    }
    const exec = this.executorFor(mode);
    if (!exec) return;
    // Voorkom dat dezelfde mint tijdens de koop nogmaals geselecteerd wordt
    this.cooldown.set(m.mint, Infinity);
    try {
      const fill = await exec.buy({
        mint: m.mint,
        solAmount: s.risk.solPerTrade,
        slippagePct: s.general.slippagePct,
        priorityFeeSol: s.general.priorityFeeSol,
      });
      const pos = this.positions.record({ mint: m.mint, symbol: m.symbol, name: m.name, mode, fill, graduated: m.graduated });
      logger.info(
        { id: pos.id, symbol: m.symbol, mode, sol: +fill.solAmount.toFixed(5), via: fill.executor, sig: fill.signature, rtLossPct: safety.roundTripLossPct?.toFixed(1), devPct: safety.creatorPct?.toFixed(1), top10Pct: safety.top10Pct === null ? 'n.v.t.' : safety.top10Pct?.toFixed(1) },
        'GEKOCHT',
      );
      if (mode === 'live') void this.refreshWallet();
    } catch (e) {
      // Na een mislukte koop niet direct opnieuw proberen
      this.cooldown.set(m.mint, Date.now() + 10 * 60_000);
      logger.error({ symbol: m.symbol, err: String(e) }, 'koop mislukt');
    }
  }
}
