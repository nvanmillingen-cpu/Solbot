import type { Connection } from '@solana/web3.js';
import { config } from '../config.js';
import { kvGet, kvSet, type Db } from '../db.js';
import type { Executor } from '../executor/types.js';
import { logger } from '../logger.js';
import { solUsd, solUsdAgeMs } from '../market/solPrice.js';
import type { SettingsStore } from '../settings.js';
import { solBalance, type Wallet } from '../wallet.js';
import { evaluateFilters, passesExceptHolders, type FilterResult } from './filters.js';
import type { TokenMetrics } from './metrics.js';
import type { PositionManager } from './positions.js';
import { health } from './health.js';
import { preBuyChecks, probeTop10Support, top10Status } from './safety.js';
import type { SkipLog } from './skipped.js';
import { computeMomentum, evaluateMomentum, type Momentum } from './momentum.js';
import { lastPrice } from './metrics.js';
import { startOfToday } from './stats.js';
import type { TokenTracker } from './tracker.js';

export interface Candidate {
  metrics: TokenMetrics;
  filter: FilterResult;
  status?: string;
  /** Moment van de evaluatie (filters gehaald). */
  evalAt?: number;
}

/** Korte, stabiele sleutel voor een afwijsreden (zonder getallen), voor de tabel skipped_tokens. */
export function reasonKey(reason: string): string {
  return reason.replace(/[-+]?[\d.,]+\s*%?/g, '#').replace(/\$#/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60);
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
  /** Sinds wanneer de bot aan staat (voor de run-timer in het dashboard). */
  startedAt: number | null = null;

  constructor(
    private db: Db,
    private conn: Connection,
    private store: SettingsStore,
    private tracker: TokenTracker,
    private positions: PositionManager,
    private wallet: Wallet | null,
    private executorFor: (mode: 'paper' | 'live') => Executor | null,
    private skipLog?: SkipLog,
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
    this.startedAt = Date.now();
    kvSet(this.db, 'bot_running', 'true');
    logger.info({ mode: this.mode, config: this.store.hash() }, 'bot gestart');
  }

  stop() {
    this.running = false;
    this.startedAt = null;
    kvSet(this.db, 'bot_running', 'false');
    logger.info('bot gestopt (open posities worden nog wel bewaakt)');
  }

  /** De evaluatielus draait altijd (voor het dashboard); kopen alleen als de bot aan staat. */
  startLoop() {
    this.timer = setInterval(() => void this.evaluate(), 2000);
    setInterval(() => void this.refreshWallet(), 30_000);
    void this.refreshWallet();
    // Hartslag: detecteert slaapstand/bevriezing en laat bij een crash zien wanneer de bot stopte
    setInterval(() => {
      health.beat(this.positions.open().length);
      kvSet(this.db, 'heartbeat', String(Date.now()));
    }, 5000);
    // Top-10-check faalde: regelmatig opnieuw testen, anders blijft kopen voor altijd geblokkeerd
    setInterval(() => {
      if (top10Status.ok === false && this.store.get().safety.maxTop10Pct.enabled) void probeTop10Support(this.conn);
    }, 60_000);
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
    // Fail-closed: zonder betrouwbare prijsdata niets kopen
    const down = health.downFeeds();
    if (down.length) return `prijsfeed uitgevallen (${down.join(', ')}); open posities mogelijk onbewaakt`;
    if (solUsdAgeMs() > 5 * 60_000) return 'SOL-prijs onbekend of ouder dan 5 min (USD-filters onbetrouwbaar)';
    if (s.safety.maxTop10Pct.enabled && s.safety.maxTop10Pct.requireData && top10Status.ok === false) {
      return `top-10-holdercheck werkt niet (RPC: ${top10Status.lastError.slice(0, 80)})`;
    }
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
        candidates.push({ metrics: m, filter, evalAt: now });
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
      this.recordNearMisses(candidates);

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
            this.skipLog?.record(m, { stage: 'holders', reasonKey: 'minHolders', reason: `holders ${h?.value} < ${h?.required}`, value: h?.value, required: h?.required, checks: c.filter.checks });
            this.cooldown.set(m.mint, Date.now() + 60_000);
            continue;
          }
        }
        c.evalAt = Date.now();
        await this.tryBuy(c);
      }
    } catch (e) {
      logger.warn({ err: String(e) }, 'evaluatie mislukt');
    } finally {
      this.evaluating = false;
    }
  }

  /**
   * Counterfactual: tokens die op precies één filter na gekocht zouden zijn, vastleggen (één keer
   * per token en filter). Een onbekend aantal holders telt niet: dat wordt pas vlak voor kopen opgehaald.
   */
  private recordNearMisses(candidates: Candidate[]) {
    if (!this.skipLog) return;
    for (const c of candidates) {
      if (c.filter.pass || this.positions.everBought(c.metrics.mint)) continue;
      const failed = c.filter.checks.filter((x) => !x.pass);
      if (failed.length !== 1) continue;
      const f = failed[0];
      if (f.key === 'minHolders' && c.metrics.holders === null) continue;
      this.skipLog.record(c.metrics, { stage: 'filter', reasonKey: f.key, reason: `${f.label}: ${f.value} (nodig ${f.required})`, value: f.value, required: f.required, checks: c.filter.checks, momentum: this.momentumFor(c.metrics.mint, null, Date.now()) });
    }
  }

  /** Momentum op dit moment (verse prijs als die er is, anders de laatst bekende). */
  private momentumFor(mint: string, price: number | null, at: number): Momentum | null {
    const t = this.tracker.tokens.get(mint);
    if (!t) return null;
    return computeMomentum(t.prices, price ?? lastPrice(t)?.priceSol ?? null, at);
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
    const safety = await preBuyChecks(this.conn, s, m, s.risk.solPerTrade, tracked?.creator);
    if (!safety.ok) {
      this.cooldown.set(m.mint, safety.permanent ? Infinity : Date.now() + 5 * 60_000);
      logger.info({ symbol: m.symbol, redenen: safety.reasons }, 'veiligheidscheck afgekeurd');
      const reason = safety.reasons.join('; ') || 'onbekend';
      this.skipLog?.record(m, { stage: 'veiligheid', reasonKey: reasonKey(safety.reasons[0] ?? 'onbekend'), reason, checks: c.filter.checks, top10Pct: safety.top10Pct, creatorPct: safety.creatorPct, holders: safety.holders, momentum: this.momentumFor(m.mint, safety.checkPriceSol ?? null, Date.now()) });
      return;
    }
    // Momentum vlak vóór verzending, op de verse on-chain prijs uit de veiligheidscheck
    const momentum = this.momentumFor(m.mint, safety.checkPriceSol ?? null, safety.checkAt ?? Date.now());
    const mom = evaluateMomentum(momentum ?? { m60: null, m30: null, m10: null, m1: null }, s.filters.momentum);
    if (!mom.ok) {
      // Momentum verandert snel: na een korte pauze opnieuw beoordelen
      this.cooldown.set(m.mint, Date.now() + 30_000);
      logger.info({ symbol: m.symbol, momentum, redenen: mom.reasons }, 'afgekeurd op momentum');
      this.skipLog?.record(m, { stage: 'momentum', reasonKey: reasonKey(mom.reasons[0]), reason: mom.reasons.join('; '), checks: c.filter.checks, top10Pct: safety.top10Pct, creatorPct: safety.creatorPct, holders: safety.holders, momentum });
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
        slippagePct: s.general.buySlippagePct,
        priorityFeeSol: s.general.priorityFeeSol,
        maxQuoteDeviationPct: s.safety.maxQuoteDeviationPct,
      });
      const entry = {
        ageMin: m.ageMin,
        mcapUsd: m.marketCapUsd,
        volTotalUsd: m.volumeTotalUsd,
        vol10mUsd: m.volume10mUsd,
        priceChangePct: m.priceChangePct,
        // Holders uit de top-10-call (max. 19 = ondergrens), anders uit de tracker
        holders: safety.holders ?? m.holders,
        top10Pct: safety.top10Pct ?? null,
        creatorPct: safety.creatorPct ?? null,
        rtLossPct: safety.roundTripLossPct ?? null,
        // Tijdstempels en prijzen per stap: evaluatie → check → verzending → landing
        evalAt: c.evalAt ?? null,
        evalPriceSol: m.priceSol,
        checkAt: safety.checkAt ?? null,
        checkPriceSol: safety.checkPriceSol ?? null,
        sentAt: fill.sentAt ?? null,
        sentPriceSol: fill.marketPriceSol ?? safety.checkPriceSol ?? null,
        landedAt: fill.landedAt ?? null,
        landedPriceSol: fill.landedMarketPriceSol ?? null,
        momentum,
      };
      const pos = this.positions.record({ mint: m.mint, symbol: m.symbol, name: m.name, mode, fill, graduated: m.graduated, configHash: this.store.hash(), entry });
      const r1 = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? null : +n.toFixed(d));
      logger.info(
        {
          id: pos.id,
          symbol: m.symbol,
          mint: m.mint,
          mode,
          sol: +fill.solAmount.toFixed(5),
          via: fill.executor,
          config: pos.config_hash,
          instapVsMarktPct: pos.entry_market_price_sol ? r1((pos.entry_price_sol / pos.entry_market_price_sol - 1) * 100, 2) : null,
          leeftijdMin: r1(entry.ageMin),
          mcapUsd: r1(entry.mcapUsd, 0),
          volTotaalUsd: r1(entry.volTotalUsd, 0),
          vol10mUsd: r1(entry.vol10mUsd, 0),
          stijgingPct: r1(entry.priceChangePct),
          holders: entry.holders,
          top10Pct: entry.top10Pct === null ? 'n.v.t.' : r1(entry.top10Pct),
          makerPct: r1(entry.creatorPct),
          rtLossPct: r1(entry.rtLossPct),
          momentum60sPct: momentum?.m60 ?? null,
          momentum30sPct: momentum?.m30 ?? null,
          momentum10sPct: momentum?.m10 ?? null,
          momentum1sPct: momentum?.m1 ?? null,
          // Waar ontstaat de instap-premie? Prijs per stap t.o.v. de evaluatieprijs, en de duur per stap
          premieCheckPct: entry.evalPriceSol && entry.checkPriceSol ? r1((entry.checkPriceSol / entry.evalPriceSol - 1) * 100, 2) : null,
          premieVerzendPct: entry.evalPriceSol && entry.sentPriceSol ? r1((entry.sentPriceSol / entry.evalPriceSol - 1) * 100, 2) : null,
          premieLandingPct: entry.evalPriceSol && entry.landedPriceSol ? r1((entry.landedPriceSol / entry.evalPriceSol - 1) * 100, 2) : null,
          premieFillPct: entry.evalPriceSol ? r1((pos.entry_price_sol / entry.evalPriceSol - 1) * 100, 2) : null,
          evalNaarCheckMs: entry.evalAt && entry.checkAt ? entry.checkAt - entry.evalAt : null,
          checkNaarVerzendMs: entry.checkAt && entry.sentAt ? entry.sentAt - entry.checkAt : null,
          verzendNaarLandingMs: entry.sentAt && entry.landedAt ? entry.landedAt - entry.sentAt : null,
          sig: fill.signature,
        },
        'GEKOCHT',
      );
      if (mode === 'live') void this.refreshWallet();
    } catch (e) {
      // Na een mislukte koop niet direct opnieuw proberen
      this.cooldown.set(m.mint, Date.now() + 10 * 60_000);
      const msg = String(e instanceof Error ? e.message : e);
      this.skipLog?.record(m, { stage: 'koop', reasonKey: reasonKey(msg), reason: msg, checks: c.filter.checks, top10Pct: safety.top10Pct, creatorPct: safety.creatorPct, holders: safety.holders, momentum });
      logger.error({ symbol: m.symbol, err: String(e) }, 'koop mislukt');
    }
  }
}
