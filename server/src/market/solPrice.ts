import { SOL_MINT } from '../config.js';
import { health } from '../core/health.js';
import { fetchJson } from '../util/http.js';
import { jupPricesUsd } from './jupiter.js';

let cached = { usd: 0, at: 0 };
let lastAttempt = 0;
/** Na een mislukte poging niet vaker dan dit opnieuw proberen (voorkomt een logregel elke 2 s). */
const RETRY_MS = 10_000;

/** SOL/USD, max 60 s oud. Jupiter, met DexScreener als fallback. Gooit nooit: geeft laatst bekende waarde. */
export async function solUsd(): Promise<number> {
  const now = Date.now();
  if (cached.usd && now - cached.at < 60_000) return cached.usd;
  if (now - lastAttempt < RETRY_MS) return cached.usd;
  lastAttempt = now;
  try {
    const p = (await jupPricesUsd([SOL_MINT])).get(SOL_MINT);
    if (!p) throw new Error('Jupiter gaf geen SOL-prijs');
    cached = { usd: p, at: Date.now() };
    health.ok('solPrijs');
  } catch (e) {
    try {
      const pairs = await fetchJson<{ priceUsd?: string; quoteToken: { symbol: string }; liquidity?: { usd?: number } }[]>(
        `https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`,
      );
      const best = pairs.filter((p) => p.quoteToken.symbol.startsWith('USD')).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (!best?.priceUsd) throw new Error('DexScreener gaf geen SOL-prijs');
      cached = { usd: Number(best.priceUsd), at: Date.now() };
      health.ok('solPrijs');
    } catch {
      // Logging gebeurt bij de overgang naar "uitgevallen" (health), niet bij elke poging
      health.fail('solPrijs', e);
    }
  }
  return cached.usd;
}

export function solUsdCached(): number {
  return cached.usd;
}

/** Leeftijd van de SOL-prijs in ms (Infinity als er nog nooit een prijs was). */
export function solUsdAgeMs(now = Date.now()): number {
  return cached.at ? now - cached.at : Infinity;
}
