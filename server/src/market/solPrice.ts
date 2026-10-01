import { SOL_MINT } from '../config.js';
import { logger } from '../logger.js';
import { fetchJson } from '../util/http.js';
import { jupPricesUsd } from './jupiter.js';

let cached = { usd: 0, at: 0 };

/** SOL/USD, max 60 s oud. Jupiter, met DexScreener als fallback. Gooit nooit: geeft laatst bekende waarde. */
export async function solUsd(): Promise<number> {
  if (cached.usd && Date.now() - cached.at < 60_000) return cached.usd;
  try {
    const p = (await jupPricesUsd([SOL_MINT])).get(SOL_MINT);
    if (p) cached = { usd: p, at: Date.now() };
  } catch (e) {
    try {
      const pairs = await fetchJson<{ priceUsd?: string; quoteToken: { symbol: string }; liquidity?: { usd?: number } }[]>(
        `https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`,
      );
      const best = pairs.filter((p) => p.quoteToken.symbol.startsWith('USD')).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (best?.priceUsd) cached = { usd: Number(best.priceUsd), at: Date.now() };
    } catch {
      logger.warn({ err: String(e) }, 'SOL-prijs niet op te halen, gebruik laatst bekende');
    }
  }
  return cached.usd;
}

export function solUsdCached(): number {
  return cached.usd;
}
