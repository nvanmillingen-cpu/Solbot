import { SOL_MINT } from '../config.js';
import { logger } from '../logger.js';
import { curveBuyQuote, curvePriceSol, curveSellQuote, type CurveState } from '../market/bondingCurve.js';
import { jupQuote } from '../market/jupiter.js';
import { BASE_FEE_SOL, type BuyRequest, type Executor, type Fill, type SellRequest } from './types.js';

export interface PaperPriceSource {
  /** Laatst bekende prijs (fallback als er geen quote/curve is). */
  lastPrice(mint: string): number | null;
  /** Verse on-chain curve (undefined als het token geen curve heeft). */
  freshCurve(mint: string): Promise<CurveState | undefined>;
}

/** Waarschuw als quote en curve meer dan dit % verschillen. */
const WARN_DEVIATION_PCT = 10;

/**
 * Paper mode: geen echte transacties. Voor tokens op de bonding curve wordt de fill
 * berekend met zowel de Jupiter-quote als de exacte pump.fun-curvewiskunde op een
 * verse on-chain stand; de ONGUNSTIGSTE van de twee telt (conservatief). Voor
 * gegradueerde tokens alleen Jupiter. Fallback: laatste prijs met halve slippage.
 */
export class PaperExecutor implements Executor {
  readonly name = 'paper';

  constructor(private src: PaperPriceSource) {}

  private async curve(mint: string): Promise<CurveState | undefined> {
    try {
      const c = await this.src.freshCurve(mint);
      return c && !c.complete ? c : undefined;
    } catch {
      return undefined;
    }
  }

  async buy(r: BuyRequest): Promise<Fill> {
    const lamports = BigInt(Math.round(r.solAmount * 1e9));
    const fees = r.priorityFeeSol + BASE_FEE_SOL;
    const [curve, jup] = await Promise.all([this.curve(r.mint), jupQuote(SOL_MINT, r.mint, lamports, r.slippagePct).catch(() => null)]);
    const curveOut = curve ? curveBuyQuote(curve, lamports) : null;
    const jupOut = jup ? BigInt(jup.outAmount) : null;
    const market = curve ? curvePriceSol(curve) : undefined;
    if (curveOut !== null && jupOut !== null) {
      const dev = (Number(jupOut) / Number(curveOut) - 1) * 100;
      if (Math.abs(dev) > WARN_DEVIATION_PCT) logger.warn({ mint: r.mint, devPct: dev.toFixed(1) }, 'paper buy: Jupiter-quote wijkt af van on-chain curve; ongunstigste gebruikt');
      const worse = jupOut < curveOut ? jupOut : curveOut;
      return { solAmount: r.solAmount + fees, tokenAmountRaw: worse, decimals: 6, executor: jupOut < curveOut ? 'paper/jupiter' : 'paper/curve', marketPriceSol: market };
    }
    if (jupOut !== null) return { solAmount: r.solAmount + fees, tokenAmountRaw: jupOut, decimals: 6, executor: 'paper/jupiter', marketPriceSol: market };
    if (curveOut !== null && curveOut > 0n) return { solAmount: r.solAmount + fees, tokenAmountRaw: curveOut, decimals: 6, executor: 'paper/curve', marketPriceSol: market };
    const p = this.src.lastPrice(r.mint);
    if (p) {
      const tokens = (r.solAmount / p) * (1 - r.slippagePct / 200);
      return { solAmount: r.solAmount + fees, tokenAmountRaw: BigInt(Math.floor(tokens * 1e6)), decimals: 6, executor: 'paper/price', marketPriceSol: p };
    }
    throw new Error('paper buy: geen quote, curve of prijs beschikbaar');
  }

  async sell(r: SellRequest): Promise<Fill> {
    const fees = r.priorityFeeSol + BASE_FEE_SOL;
    const [curve, jup] = await Promise.all([this.curve(r.mint), jupQuote(r.mint, SOL_MINT, r.tokenAmountRaw, r.slippagePct).catch(() => null)]);
    const curveOut = curve ? curveSellQuote(curve, r.tokenAmountRaw) : null;
    const jupOut = jup ? BigInt(jup.outAmount) : null;
    const market = curve ? curvePriceSol(curve) : undefined;
    let gross: number;
    let via: string;
    if (curveOut !== null && jupOut !== null) {
      const dev = (Number(jupOut) / Number(curveOut || 1n) - 1) * 100;
      if (Math.abs(dev) > WARN_DEVIATION_PCT) logger.warn({ mint: r.mint, devPct: dev.toFixed(1) }, 'paper sell: Jupiter-quote wijkt af van on-chain curve; ongunstigste gebruikt');
      gross = Number(jupOut < curveOut ? jupOut : curveOut) / 1e9;
      via = jupOut < curveOut ? 'paper/jupiter' : 'paper/curve';
    } else if (jupOut !== null) {
      gross = Number(jupOut) / 1e9;
      via = 'paper/jupiter';
    } else if (curveOut !== null) {
      gross = Number(curveOut) / 1e9;
      via = 'paper/curve';
    } else {
      const p = this.src.lastPrice(r.mint);
      if (p) {
        gross = (Number(r.tokenAmountRaw) / 10 ** r.decimals) * p * (1 - r.slippagePct / 200);
        via = 'paper/price';
      } else {
        logger.warn({ mint: r.mint }, 'paper sell: geen quote, curve of prijs; waarde 0');
        gross = 0;
        via = 'paper/none';
      }
    }
    return { solAmount: Math.max(0, gross - fees), tokenAmountRaw: r.tokenAmountRaw, decimals: r.decimals, executor: via, marketPriceSol: market };
  }
}
