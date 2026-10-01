import { config, SOL_MINT } from '../config.js';
import { fetchJson, HttpError, RateLimiter } from '../util/http.js';

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: { swapInfo: { label?: string } }[];
  [k: string]: unknown;
}

/** lite-api is gratis maar gelimiteerd; we blijven er ruim onder. */
const limiter = new RateLimiter(config.jupiterApiKey ? 300 : 50, 'jupiter');

function headers(): Record<string, string> {
  return config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {};
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  await limiter.take();
  try {
    return await fetchJson<T>(`${config.jupiterApiUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      body,
      headers: headers(),
      retries: 1,
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) limiter.backoff(15_000);
    throw e;
  }
}

export async function jupQuote(inputMint: string, outputMint: string, amount: bigint, slippagePct: number): Promise<JupQuote> {
  const bps = Math.round(slippagePct * 100);
  const q = await call<JupQuote & { error?: string }>(
    `/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${bps}&restrictIntermediateTokens=true`,
  );
  if (q.error || !q.outAmount) throw new Error(`Jupiter quote mislukt: ${q.error ?? 'geen route'}`);
  return q;
}

/** Bouwt een (ongetekende) swap-transactie, base64. */
export async function jupSwapTx(quote: JupQuote, userPublicKey: string, priorityFeeSol: number): Promise<string> {
  const res = await call<{ swapTransaction?: string; error?: string }>('/swap/v1/swap', {
    quoteResponse: quote,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: false,
    prioritizationFeeLamports:
      priorityFeeSol > 0
        ? { priorityLevelWithMaxLamports: { maxLamports: Math.round(priorityFeeSol * 1e9), priorityLevel: 'veryHigh' } }
        : undefined,
  });
  if (!res.swapTransaction) throw new Error(`Jupiter swap mislukt: ${res.error ?? 'geen transactie'}`);
  return res.swapTransaction;
}

/** USD-prijzen via Price API v3 (max 50 ids per call). */
export async function jupPricesUsd(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < mints.length; i += 50) {
    const chunk = mints.slice(i, i + 50);
    const res = await call<Record<string, { usdPrice?: number } | null>>(`/price/v3?ids=${chunk.join(',')}`);
    for (const [mint, v] of Object.entries(res ?? {})) if (v?.usdPrice) out.set(mint, v.usdPrice);
  }
  return out;
}

export const isSol = (mint: string) => mint === SOL_MINT;
