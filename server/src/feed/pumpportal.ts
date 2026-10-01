import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../logger.js';

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
 */
export class PumpPortalFeed extends EventEmitter {
  private ws?: WebSocket;
  private reconnectDelay = 1000;
  private stopped = false;
  private tradeSubs = new Set<string>();
  private pingTimer?: NodeJS.Timeout;
  connected = false;
  lastMessageAt = 0;
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
      this.reconnectDelay = 1000;
      logger.info({ trades: this.tradesAvailable }, 'PumpPortal verbonden');
      this.send({ method: 'subscribeNewToken' });
      this.send({ method: 'subscribeMigration' });
      if (this.tradesAvailable && this.tradeSubs.size) this.send({ method: 'subscribeTokenTrade', keys: [...this.tradeSubs] });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        // Geen bericht in 60 s → verbinding is waarschijnlijk dood
        if (Date.now() - this.lastMessageAt > 60_000) ws.terminate();
        else if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 15_000);
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
      logger.warn({ retryInMs: this.reconnectDelay }, 'PumpPortal verbinding verbroken, opnieuw verbinden');
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    });

    ws.on('error', (e) => logger.warn({ err: e.message }, 'PumpPortal websocket fout'));
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
        receivedAt: now,
      };
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
