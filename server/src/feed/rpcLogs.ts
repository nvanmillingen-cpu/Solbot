import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PublicKey, type Connection } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '../config.js';
import { logger } from '../logger.js';
import { bondingCurvePda } from '../market/bondingCurve.js';
import type { NewTokenEvent } from './pumpportal.js';

const disc = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
const CREATE_DISC = disc('CreateEvent');
const TRADE_DISC = disc('TradeEvent');

function readStr(b: Buffer, o: number): [string, number] {
  const n = b.readUInt32LE(o);
  if (n > 500) throw new Error('ongeldige string');
  return [b.subarray(o + 4, o + 4 + n).toString('utf8'), o + 4 + n];
}

interface DecodedCreate {
  name: string;
  symbol: string;
  mint: string;
  bondingCurve: string;
  user: string;
}

/** Decodeert het pump.fun CreateEvent (Anchor event in "Program data:"-logregels). */
export function decodeCreateEvent(data: Buffer): DecodedCreate | null {
  if (data.length < 8 + 12 + 96 || !data.subarray(0, 8).equals(CREATE_DISC)) return null;
  try {
    let o = 8;
    let name: string, symbol: string;
    [name, o] = readStr(data, o);
    [symbol, o] = readStr(data, o);
    [, o] = readStr(data, o); // uri
    const mint = new PublicKey(data.subarray(o, o + 32)).toBase58();
    const bondingCurve = new PublicKey(data.subarray(o + 32, o + 64)).toBase58();
    const user = new PublicKey(data.subarray(o + 64, o + 96)).toBase58();
    // Controle: de bonding curve moet de PDA van deze mint zijn
    if (bondingCurvePda(mint).toBase58() !== bondingCurve) return null;
    return { name, symbol, mint, bondingCurve, user };
  } catch {
    return null;
  }
}

interface DecodedTrade {
  mint: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
}

/** Decodeert het pump.fun TradeEvent (alleen de vaste velden aan het begin). */
export function decodeTradeEvent(data: Buffer): DecodedTrade | null {
  if (data.length < 8 + 32 + 8 + 8 + 1 + 32 + 8 + 16 || !data.subarray(0, 8).equals(TRADE_DISC)) return null;
  let o = 8;
  const mint = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const solAmount = data.readBigUInt64LE(o);
  const tokenAmount = data.readBigUInt64LE(o + 8);
  const isBuy = data[o + 16] === 1;
  o += 17 + 32 + 8; // user + timestamp
  return { mint, solAmount, tokenAmount, isBuy, virtualSolReserves: data.readBigUInt64LE(o), virtualTokenReserves: data.readBigUInt64LE(o + 8) };
}

/** Haalt create- en trade-events uit de logregels van één transactie. */
export function parseCreateFromLogs(logs: string[], now = Date.now()): NewTokenEvent | null {
  if (!logs.some((l) => l.includes('Instruction: Create'))) return null;
  let create: DecodedCreate | null = null;
  const trades: DecodedTrade[] = [];
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const buf = Buffer.from(line.slice(14), 'base64');
    create ??= decodeCreateEvent(buf);
    const t = decodeTradeEvent(buf);
    if (t) trades.push(t);
  }
  if (!create) return null;
  const c = create;
  // Eerste aankoop van de maker in dezelfde transactie
  const first = trades.find((t) => t.mint === c.mint && t.isBuy);
  const initialBuySol = first && first.solAmount < 1000n * 1_000_000_000n ? Number(first.solAmount) / 1e9 : 0;
  // Reserves vóór de eerste aankoop = lanceringsprijs
  let vSol = 0;
  let vTok = 0;
  if (first) {
    vSol = Number(first.virtualSolReserves - first.solAmount) / 1e9;
    vTok = Number(first.virtualTokenReserves + first.tokenAmount) / 1e6;
  }
  return {
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    creator: c.user,
    bondingCurveKey: c.bondingCurve,
    initialBuySol,
    initialBuyTokens: first ? Number(first.tokenAmount) / 1e6 : 0,
    vSolInBondingCurve: vSol,
    vTokensInBondingCurve: vTok,
    marketCapSol: vTok > 0 ? (vSol / vTok) * 1e9 : 0,
    pool: 'pump',
    mayhem: false, // wordt uit het curve-account gelezen
    source: 'rpc',
    receivedAt: now,
  };
}

/**
 * Fallback-feed: nieuwe pump.fun-tokens rechtstreeks uit de RPC-logs van het
 * pump.fun-programma (logsSubscribe, gratis). Gebruikt als PumpPortal stil valt.
 */
export class RpcLogFeed extends EventEmitter {
  private subId?: number;
  active = false;
  received = 0;

  constructor(private conn: Connection) {
    super();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.subId = this.conn.onLogs(
      new PublicKey(PUMP_PROGRAM_ID),
      (l) => {
        if (l.err) return;
        const ev = parseCreateFromLogs(l.logs);
        if (ev) {
          this.received++;
          this.emit('newToken', ev);
        }
      },
      'confirmed',
    );
    logger.warn('RPC-fallbackfeed actief: nieuwe tokens worden uit de pump.fun-programmalogs gehaald');
  }

  stop() {
    if (this.subId !== undefined) void this.conn.removeOnLogsListener(this.subId).catch(() => undefined);
    this.subId = undefined;
    this.active = false;
  }
}
