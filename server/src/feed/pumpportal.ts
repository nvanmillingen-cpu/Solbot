import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';
import { logger, shouldLog } from '../logger.js';

export interface NewTokenEvent {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  bondingCurveKey?: string;
  /** SOL-bedrag van de eerste aankoop door de maker. */
  initialBuySol: number;
  initialBuyTokens: number;
  vSolInBondingCurve: number;
  vTokensInBondingCurve: number;
  marketCapSol: number;
  pool: string;
  /** pump.fun mayhem mode (volgens PumpPortal; de curve-vlag is leidend). */
  mayhem: boolean;
  source: 'pumpportal' | 'rpc';
  receivedAt: number;
}

export interface TradeEvent {
  mint: string;
  trader: string;
  isBuy: boolean;
  solAmount: number;
  tokenAmount: number;
  marketCapSol?: number;
  vSolInBondingCurve?: number;
  vTokensInBondingCurve?: number;
  pool?: string;
  receivedAt: number;
}

export interface MigrationEvent {
  mint: string;
  pool?: string;
  receivedAt: number;
}

/**
 * PumpPortal data-websocket.
 * - subscribeNewToken en subscribeMigration zijn gratis.
 * - subscribeTokenTrade vereist een API-sleutel (PUMPPORTAL_API_KEY).
 * Verbindt automatisch opnieuw met exponentiële backoff.
 *
 * Liveness: een pong op onze ping betekent dat de verbinding leeft. Leeft de verbinding
 * maar komt er geen data (PumpPortal stuurt soms niets, bijv. bij een IP-blokkade), dan
 * wordt opnieuw verbonden met een oplopende pauze (tot 5 min) i.p.v. elke ~75 s. De
 * RPC-fallbackfeed levert in die tijd de nieuwe tokens.
 */
export class PumpPortalFeed extends EventEmitter {
  private ws?: WebSocket;
  private reconnectDelay = 1000;
  private stopped = false;
  private tradeSubs = new Set<string>();
  private pingTimer?: NodeJS.Timeout;
  connected = false;
  lastMessageAt = 0;
  /** Laatste pong: de verbinding zelf leeft. */
  lastPongAt = 0;
  /** Laatste echte data (token, trade of migratie), niet alleen bevestigingen. */
  lastDataAt = 0;
  /** Aantal reconnects achter elkaar zonder dat er data binnenkwam. */
  private silentReconnects = 0;
  reconnects = 0;
  /** Laatste nieuwe token via PumpPortal (voor de fallback-feed). */
  lastNewTokenAt = 0;
  readonly tradesAvailable = Boolean(config.pumpPortalApiKey);

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private connect() {
    const url = config.pumpPortalApiKey
      ? `wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(config.pumpPortalApiKey)}`
      : 'wss://pumpportal.fun/api/data';
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      const openedAt = Date.now();
      this.lastPongAt = openedAt;
      const l = shouldLog('pp-connect', this.silentReconnects ? 10 * 60_000 : 0);
      if (l.ok) logger.info({ trades: this.tradesAvailable, stilleReconnects: this.silentReconnects, overgeslagen: l.suppressed }, 'PumpPortal verbonden');
      // Na elke (re)connect alle subscriptions opnieuw aanvragen
      this.send({ method: 'subscribeNewToken' });
      this.send({ method: 'subscribeMigration' });
      if (this.tradesAvailable && this.tradeSubs.size) this.send({ method: 'subscribeTokenTrade', keys: [...this.tradeSubs] });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        const now = Date.now();
        // Geen pong in 45 s → verbinding is dood
        if (now - this.lastPongAt > 45_000) {
          logger.warn('PumpPortal reageert niet op ping; verbinding verbreken');
          ws.terminate();
          return;
        }
        // Verbinding leeft, maar al 90 s geen data → opnieuw verbinden (met oplopende pauze)
        if (now - Math.max(this.lastDataAt, openedAt) > 90_000) {
          this.silentReconnects++;
          const s2 = shouldLog('pp-silent', 10 * 60_000);
          if (s2.ok) logger.warn({ stilleReconnects: this.silentReconnects, volgendePogingS: this.nextDelay() / 1000 }, 'PumpPortal verbonden maar stuurt geen data; opnieuw verbinden met langere pauze (RPC-fallback levert tokens)');
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 15_000);
    });

    ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handle(m);
    });

    ws.on('close', () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      if (this.stopped) return;
      this.reconnects++;
      const delay = this.nextDelay();
      const l = shouldLog('pp-close', 60_000);
      if (l.ok) logger.warn({ retryInMs: delay, overgeslagen: l.suppressed }, 'PumpPortal verbinding verbroken, opnieuw verbinden');
      setTimeout(() => this.connect(), delay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    });

    // Netwerkfouten (DNS ENOTFOUND e.d.) max. 1× per minuut loggen
    ws.on('error', (e) => {
      const l = shouldLog('pp-error', 60_000);
      if (l.ok) logger.warn({ err: e.message, overgeslagen: l.suppressed }, 'PumpPortal websocket fout');
    });
  }

  /** Pauze vóór de volgende poging: netwerkfout → exponentieel tot 60 s; stille verbinding → 30 s, 1, 2, 4, 5 min. */
  private nextDelay(): number {
    if (this.silentReconnects > 0) return Math.min(15_000 * 2 ** this.silentReconnects, 5 * 60_000);
    return this.reconnectDelay;
  }

  /** Echte data ontvangen: verbinding is gezond, backoff terug naar begin. */
  private gotData(now: number) {
    this.lastDataAt = now;
    this.reconnectDelay = 1000;
    if (this.silentReconnects) {
      logger.info({ naStilleReconnects: this.silentReconnects }, 'PumpPortal levert weer data');
      this.silentReconnects = 0;
    }
  }

  private handle(m: Record<string, unknown>) {
    const now = Date.now();
    if (typeof m.message === 'string') {
      logger.debug({ msg: m.message }, 'PumpPortal');
      if (m.message.includes('API key')) logger.warn(m.message);
      return;
    }
    const mint = m.mint as string | undefined;
    if (!mint) return;
    this.gotData(now);
    const txType = m.txType as string | undefined;
    if (txType === 'create') {
      const ev: NewTokenEvent = {
        mint,
        name: String(m.name ?? ''),
        symbol: String(m.symbol ?? ''),
        creator: String(m.traderPublicKey ?? ''),
        bondingCurveKey: m.bondingCurveKey as string | undefined,
        initialBuySol: Number(m.solAmount ?? 0),
        initialBuyTokens: Number(m.initialBuy ?? 0),
        vSolInBondingCurve: Number(m.vSolInBondingCurve ?? 0),
        vTokensInBondingCurve: Number(m.vTokensInBondingCurve ?? 0),
        marketCapSol: Number(m.marketCapSol ?? 0),
        pool: String(m.pool ?? 'pump'),
        mayhem: m.is_mayhem_mode === true,
        source: 'pumpportal',
        receivedAt: now,
      };
      this.lastNewTokenAt = now;
      this.emit('newToken', ev);
    } else if (txType === 'buy' || txType === 'sell') {
      const ev: TradeEvent = {
        mint,
        trader: String(m.traderPublicKey ?? ''),
        isBuy: txType === 'buy',
        solAmount: Number(m.solAmount ?? 0),
        tokenAmount: Number(m.tokenAmount ?? 0),
        marketCapSol: m.marketCapSol !== undefined ? Number(m.marketCapSol) : undefined,
        vSolInBondingCurve: m.vSolInBondingCurve !== undefined ? Number(m.vSolInBondingCurve) : undefined,
        vTokensInBondingCurve: m.vTokensInBondingCurve !== undefined ? Number(m.vTokensInBondingCurve) : undefined,
        pool: m.pool as string | undefined,
        receivedAt: now,
      };
      this.emit('trade', ev);
    } else if (txType === 'migrate' || txType === 'migration' || (!txType && m.signature)) {
      const ev: MigrationEvent = { mint, pool: m.pool as string | undefined, receivedAt: now };
      this.emit('migration', ev);
    }
  }

  subscribeTrades(mints: string[]) {
    if (!this.tradesAvailable) return;
    const fresh = mints.filter((m) => !this.tradeSubs.has(m));
    if (!fresh.length) return;
    fresh.forEach((m) => this.tradeSubs.add(m));
    this.send({ method: 'subscribeTokenTrade', keys: fresh });
  }

  unsubscribeTrades(mints: string[]) {
    if (!this.tradesAvailable) return;
    const gone = mints.filter((m) => this.tradeSubs.delete(m));
    if (gone.length) this.send({ method: 'unsubscribeTokenTrade', keys: gone });
  }

  private send(o: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }
}
