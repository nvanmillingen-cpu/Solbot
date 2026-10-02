import { PUMP_TOTAL_SUPPLY } from '../config.js';
import type { CurveState } from '../market/bondingCurve.js';
import type { DexInfo } from '../market/dexscreener.js';

export interface PricePoint {
  t: number;
  priceSol: number;
}

export interface VolumePoint {
  t: number;
  sol: number;
}

export interface TrackedToken {
  mint: string;
  name: string;
  symbol: string;
  creator?: string;
  /** Moment dat wij het token zagen. */
  firstSeenAt: number;
  /** Aanmaakmoment (alleen bekend voor tokens uit de new-token stream). */
  createdAt?: number;
  source: 'new' | 'migration' | 'manual';
  graduated: boolean;
  /** pump.fun mayhem mode (2B supply, AI-agent handelt mee). */
  mayhem: boolean;
  launchPriceSol?: number;
  initialBuySol: number;
  prices: PricePoint[];
  curve?: CurveState;
  curveUpdatedAt?: number;
  /** Absolute SOL-veranderingen in de curve tussen polls (ondergrens van bruto volume). */
  curveVolume: VolumePoint[];
  dex?: DexInfo;
  dexVolSnapshots: { t: number; h24: number }[];
  /** true als per-token trades binnenkomen (PumpPortal API-sleutel). */
  tradeStream: boolean;
  /** Alleen gevuld met PumpPortal API-sleutel. */
  trades: VolumePoint[];
  balances: Map<string, number>;
  holdersRpc?: { count: number; capped: boolean; at: number };
}

export interface TokenMetrics {
  mint: string;
  symbol: string;
  name: string;
  ageMin: number | null;
  graduated: boolean;
  /** true = bonding-curve-account gevonden en niet voltooid; false = voltooid/gemigreerd; null = (nog) onbekend. */
  onCurve: boolean | null;
  mayhem: boolean;
  priceSol: number | null;
  marketCapUsd: number | null;
  priceChangePct: number | null;
  volumeTotalUsd: number | null;
  volume10mUsd: number | null;
  volumeSource: 'trades' | 'dexscreener' | 'curve' | 'none';
  holders: number | null;
  /** true als `holders` een ondergrens is (RPC geeft max 20 accounts). */
  holdersCapped: boolean;
  liquidityUsd: number | null;
}

const TEN_MIN = 10 * 60_000;

export function newTrackedToken(p: Partial<TrackedToken> & Pick<TrackedToken, 'mint' | 'source'>): TrackedToken {
  return {
    name: '',
    symbol: '',
    firstSeenAt: Date.now(),
    graduated: false,
    mayhem: false,
    initialBuySol: 0,
    prices: [],
    curveVolume: [],
    dexVolSnapshots: [],
    tradeStream: false,
    trades: [],
    balances: new Map(),
    ...p,
  };
}

export function lastPrice(t: TrackedToken): PricePoint | undefined {
  return t.prices[t.prices.length - 1];
}

export function addPrice(t: TrackedToken, p: PricePoint, maxPoints = 600) {
  const last = lastPrice(t);
  if (last && last.priceSol === p.priceSol && p.t - last.t < 30_000) return;
  if (last && p.t < last.t) return;
  t.prices.push(p);
  if (t.prices.length > maxPoints) t.prices.splice(0, t.prices.length - maxPoints);
}

function sumSince(points: VolumePoint[], since: number): number {
  let s = 0;
  for (let i = points.length - 1; i >= 0 && points[i].t >= since; i--) s += points[i].sol;
  return s;
}

/** Prijs op of vlak na `at` (eerste punt met t ≥ at). */
function priceAtOrAfter(points: PricePoint[], at: number): PricePoint | undefined {
  for (const p of points) if (p.t >= at) return p;
  return undefined;
}

export function computeMetrics(t: TrackedToken, now: number, solUsd: number, priceWindowMin: number): TokenMetrics {
  const createdAt = t.createdAt ?? (t.dex?.pairCreatedAt && t.source !== 'migration' ? t.dex.pairCreatedAt : undefined);
  const ageMin = createdAt ? (now - createdAt) / 60_000 : (now - t.firstSeenAt) / 60_000;
  const last = lastPrice(t);
  const priceSol = last?.priceSol ?? (t.dex?.priceNative || null);
  const usd = solUsd > 0 ? solUsd : null;

  // Market cap
  let marketCapUsd: number | null = null;
  const supply = t.mayhem ? 2 * PUMP_TOTAL_SUPPLY : PUMP_TOTAL_SUPPLY;
  if (priceSol && usd) marketCapUsd = priceSol * supply * usd;
  else if (t.dex?.marketCapUsd) marketCapUsd = t.dex.marketCapUsd;

  // Prijsverandering binnen venster
  let priceChangePct: number | null = null;
  const windowStart = now - priceWindowMin * 60_000;
  let ref: number | undefined;
  if (t.launchPriceSol && createdAt && createdAt >= windowStart) ref = t.launchPriceSol;
  else {
    const p = priceAtOrAfter(t.prices, windowStart);
    // Alleen bruikbaar als we het begin van het venster ongeveer gezien hebben
    if (p && p.t - windowStart < Math.max(60_000, priceWindowMin * 60_000 * 0.25) && p !== last) ref = p.priceSol;
  }
  if (ref && priceSol) priceChangePct = (priceSol / ref - 1) * 100;
  else if (t.dex) {
    const pc = t.dex.priceChange;
    priceChangePct = priceWindowMin <= 5 ? pc.m5 : priceWindowMin <= 60 ? pc.h1 : priceWindowMin <= 360 ? pc.h6 : pc.h24;
  }

  // Volume
  let volumeTotalUsd: number | null = null;
  let volume10mUsd: number | null = null;
  let volumeSource: TokenMetrics['volumeSource'] = 'none';
  const createdRecently = createdAt !== undefined && now - createdAt <= TEN_MIN;
  if (t.tradeStream) {
    volumeSource = 'trades';
    const total = t.initialBuySol + sumSince(t.trades, 0);
    const tenMin = sumSince(t.trades, now - TEN_MIN) + (createdRecently ? t.initialBuySol : 0);
    if (usd) {
      volumeTotalUsd = total * usd;
      volume10mUsd = tenMin * usd;
    }
  } else {
    let curveTotal: number | null = null;
    let curve10: number | null = null;
    if (t.curveVolume.length || t.curve) {
      curveTotal = t.initialBuySol + sumSince(t.curveVolume, 0);
      curve10 = sumSince(t.curveVolume, now - TEN_MIN) + (createdRecently ? t.initialBuySol : 0);
      if (usd) {
        curveTotal *= usd;
        curve10 *= usd;
      } else {
        curveTotal = curve10 = null;
      }
    }
    let dexTotal: number | null = null;
    let dex10: number | null = null;
    if (t.dex) {
      dexTotal = t.dex.volumeUsd.h24;
      if (createdRecently) dex10 = dexTotal;
      else {
        // h24-volume nu minus h24-volume ~10 min geleden
        const snap = [...t.dexVolSnapshots].reverse().find((s) => s.t <= now - TEN_MIN);
        if (snap && now - snap.t <= 15 * 60_000) dex10 = Math.max(0, dexTotal - snap.h24);
        else dex10 = t.dex.volumeUsd.m5 * 2;
      }
    }
    if (dexTotal !== null || curveTotal !== null) {
      volumeSource = dexTotal !== null && (curveTotal === null || dexTotal >= curveTotal) ? 'dexscreener' : 'curve';
      volumeTotalUsd = Math.max(dexTotal ?? 0, curveTotal ?? 0);
      volume10mUsd = Math.max(dex10 ?? 0, curve10 ?? 0);
    }
  }

  // Holders
  let holders: number | null = null;
  let holdersCapped = false;
  if (t.tradeStream) holders = [...t.balances.values()].filter((b) => b > 0).length;
  else if (t.holdersRpc && now - t.holdersRpc.at < 120_000) {
    holders = t.holdersRpc.count;
    holdersCapped = t.holdersRpc.capped;
  }

  // Liquiditeit
  let liquidityUsd: number | null = null;
  if (t.graduated) liquidityUsd = t.dex?.liquidityUsd ?? null;
  else if (t.curve && usd) liquidityUsd = (Number(t.curve.realSolReserves) / 1e9) * usd;

  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    ageMin,
    graduated: t.graduated,
    onCurve: t.graduated ? false : t.curve ? !t.curve.complete : null,
    mayhem: t.mayhem,
    priceSol,
    marketCapUsd,
    priceChangePct,
    volumeTotalUsd,
    volume10mUsd,
    volumeSource,
    holders,
    holdersCapped,
    liquidityUsd,
  };
}
