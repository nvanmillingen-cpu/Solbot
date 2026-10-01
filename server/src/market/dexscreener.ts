import { fetchJson, HttpError, RateLimiter } from '../util/http.js';
import { logger } from '../logger.js';

/** Samengevatte DexScreener-data per token (beste pair op liquiditeit). */
export interface DexInfo {
  mint: string;
  dexId: string;
  pairAddress: string;
  priceUsd: number;
  priceNative: number;
  volumeUsd: { m5: number; h1: number; h6: number; h24: number };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  liquidityUsd: number;
  marketCapUsd: number;
  pairCreatedAt?: number;
  buysH24: number;
  sellsH24: number;
  fetchedAt: number;
}

interface RawPair {
  dexId: string;
  pairAddress: string;
  baseToken: { address: string };
  quoteToken: { address: string };
  priceNative?: string;
  priceUsd?: string;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  txns?: Record<string, { buys: number; sells: number }>;
}

const BASE = 'https://api.dexscreener.com';
/** Officiële limiet is 300/min voor deze endpoint; we blijven er ruim onder. */
const limiter = new RateLimiter(200, 'dexscreener');

/** Haalt info op voor max 30 tokens per call. Tokens die DexScreener (nog) niet kent ontbreken. */
export async function fetchDexInfo(mints: string[]): Promise<Map<string, DexInfo>> {
  const out = new Map<string, DexInfo>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    await limiter.take();
    let pairs: RawPair[];
    try {
      pairs = await fetchJson<RawPair[]>(`${BASE}/tokens/v1/solana/${chunk.join(',')}`, { retries: 1 });
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) limiter.backoff(30_000);
      logger.debug({ err: String(e) }, 'DexScreener fout');
      continue;
    }
    const now = Date.now();
    for (const p of pairs ?? []) {
      const mint = p.baseToken?.address;
      if (!mint || !chunk.includes(mint)) continue;
      const liq = p.liquidity?.usd ?? 0;
      const prev = out.get(mint);
      // Meerdere pairs: neem het pair met de meeste liquiditeit, maar tel volume op.
      const vol = {
        m5: p.volume?.m5 ?? 0,
        h1: p.volume?.h1 ?? 0,
        h6: p.volume?.h6 ?? 0,
        h24: p.volume?.h24 ?? 0,
      };
      const info: DexInfo = {
        mint,
        dexId: p.dexId,
        pairAddress: p.pairAddress,
        priceUsd: Number(p.priceUsd ?? 0),
        priceNative: Number(p.priceNative ?? 0),
        volumeUsd: vol,
        priceChange: {
          m5: p.priceChange?.m5 ?? 0,
          h1: p.priceChange?.h1 ?? 0,
          h6: p.priceChange?.h6 ?? 0,
          h24: p.priceChange?.h24 ?? 0,
        },
        liquidityUsd: liq,
        marketCapUsd: p.marketCap ?? p.fdv ?? 0,
        pairCreatedAt: p.pairCreatedAt,
        buysH24: p.txns?.h24?.buys ?? 0,
        sellsH24: p.txns?.h24?.sells ?? 0,
        fetchedAt: now,
      };
      if (prev) {
        const best = liq > prev.liquidityUsd ? info : prev;
        best.volumeUsd = {
          m5: prev.volumeUsd.m5 + vol.m5,
          h1: prev.volumeUsd.h1 + vol.h1,
          h6: prev.volumeUsd.h6 + vol.h6,
          h24: prev.volumeUsd.h24 + vol.h24,
        };
        out.set(mint, best);
      } else {
        out.set(mint, info);
      }
    }
  }
  return out;
}
