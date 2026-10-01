import { SOL_MINT } from '../config.js';
import { logger } from '../logger.js';
import { curveBuyQuote, curveSellQuote, type CurveState } from '../market/bondingCurve.js';
import { jupQuote } from '../market/jupiter.js';
import { BASE_FEE_SOL, type BuyRequest, type Executor, type Fill, type SellRequest } from './types.js';

export interface PaperPriceSource {
  (mint: string): { priceSol: number | null; curve?: CurveState; graduated: boolean };
}

/**
 * Paper mode: geen echte transacties. Vult tegen een echte Jupiter-quote (inclusief
 * fees, slippage en price impact), met als fallback de curve-wiskunde of de laatste prijs.
 */
export class PaperExecutor implements Executor {
  readonly name = 'paper';

  constructor(private price: PaperPriceSource) {}

  async buy(r: BuyRequest): Promise<Fill> {
    const lamports = BigInt(Math.round(r.solAmount * 1e9));
    const fees = r.priorityFeeSol + BASE_FEE_SOL;
    try {
      const q = await jupQuote(SOL_MINT, r.mint, lamports, r.slippagePct);
      return { solAmount: r.solAmount + fees, tokenAmountRaw: BigInt(q.outAmount), decimals: 6, executor: 'paper/jupiter' };
    } catch (e) {
      const src = this.price(r.mint);
      if (src.curve && !src.curve.complete) {
        const out = curveBuyQuote(src.curve, lamports);
        if (out > 0n) return { solAmount: r.solAmount + fees, tokenAmountRaw: out, decimals: 6, executor: 'paper/curve' };
      }
      if (src.priceSol) {
        // Pessimistisch: halve slippage als verlies
        const tokens = (r.solAmount / src.priceSol) * (1 - r.slippagePct / 200);
        return { solAmount: r.solAmount + fees, tokenAmountRaw: BigInt(Math.floor(tokens * 1e6)), decimals: 6, executor: 'paper/price' };
      }
      throw e;
    }
  }

  async sell(r: SellRequest): Promise<Fill> {
    const fees = r.priorityFeeSol + BASE_FEE_SOL;
    let gross: number | null = null;
    let via = 'paper/jupiter';
    try {
      const q = await jupQuote(r.mint, SOL_MINT, r.tokenAmountRaw, r.slippagePct);
      gross = Number(q.outAmount) / 1e9;
    } catch (e) {
      const src = this.price(r.mint);
      if (src.curve && !src.curve.complete) {
        gross = Number(curveSellQuote(src.curve, r.tokenAmountRaw)) / 1e9;
        via = 'paper/curve';
      } else if (src.priceSol) {
        gross = (Number(r.tokenAmountRaw) / 10 ** r.decimals) * src.priceSol * (1 - r.slippagePct / 200);
        via = 'paper/price';
      } else {
        logger.warn({ mint: r.mint, err: String(e) }, 'paper sell: geen quote en geen prijs, waarde 0');
        gross = 0;
        via = 'paper/none';
      }
    }
    return { solAmount: Math.max(0, gross - fees), tokenAmountRaw: r.tokenAmountRaw, decimals: r.decimals, executor: via };
  }
}
