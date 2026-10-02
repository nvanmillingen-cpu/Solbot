import { SOL_MINT } from '../config.js';
import { logger, shouldLog } from '../logger.js';
import { curveBuyQuote, curvePriceSol, curveSellQuote, type CurveState } from '../market/bondingCurve.js';
import { jupQuote } from '../market/jupiter.js';
import { BASE_FEE_SOL, type BuyRequest, type Executor, type Fill, type SellRequest } from './types.js';

export interface PaperPriceSource {
  /** Laatst bekende prijs (fallback als er geen quote/curve is). */
  lastPrice(mint: string): number | null;
  /** Verse on-chain curve (undefined als het token geen curve heeft). */
  freshCurve(mint: string): Promise<CurveState | undefined>;
}

/** Simulatie van wat live wél gebeurt: vertraging tot de transactie landt en extra landingskosten. */
export interface PaperSim {
  latencyMs: number;
  /** Jito-tip / landingskosten per transactie, bovenop de priority fee. */
  landingFeeSol: number;
}

/** Waarschuw als quote en curve meer dan dit % verschillen. */
const WARN_DEVIATION_PCT = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Paper mode: geen echte transacties. Op de bonding curve rekent de koop met de exacte
 * pump.fun-curvewiskunde (Jupiter alleen als controle); de verkoop neemt de ONGUNSTIGSTE
 * van curve en Jupiter (conservatief). De fill gebruikt de curvestand ná de gesimuleerde
 * landingsvertraging, zoals een echte transactie die pas later in een blok komt. Voor
 * gegradueerde tokens alleen Jupiter. Fallback: laatste prijs met halve slippage.
 */
export class PaperExecutor implements Executor {
  readonly name = 'paper';

  constructor(
    private src: PaperPriceSource,
    private sim: () => PaperSim = () => ({ latencyMs: 0, landingFeeSol: 0 }),
  ) {}

  private async curve(mint: string): Promise<CurveState | undefined> {
    try {
      const c = await this.src.freshCurve(mint);
      return c && !c.complete ? c : undefined;
    } catch {
      return undefined;
    }
  }

  private fees(priorityFeeSol: number): number {
    return priorityFeeSol + BASE_FEE_SOL + this.sim().landingFeeSol;
  }

  /**
   * Koop. Op de bonding curve is de fill de exacte curve-wiskunde: on-chain voert ook een
   * Jupiter-swap precies die wiskunde uit, en de exit-bewaking kijkt naar dezelfde curve.
   * Zo zijn instap en bewaking één prijsbron (eerder gaf een achterlopende Jupiter-quote
   * als instap een "SL" binnen 1 s zonder echte koersdaling, zie 198kg). De Jupiter-quote
   * is alleen een controle: wijkt die meer af dan `maxQuoteDeviationPct`, dan geen koop.
   * `marketPriceSol` is de curveprijs op het moment van besluiten, dus de verhouding
   * instapprijs/marktprijs bevat fees, impact én de koersbeweging tijdens de vertraging.
   */
  async buy(r: BuyRequest): Promise<Fill> {
    const lamports = BigInt(Math.round(r.solAmount * 1e9));
    const fees = this.fees(r.priorityFeeSol);
    const { latencyMs } = this.sim();
    const [curve0, jup] = await Promise.all([this.curve(r.mint), jupQuote(SOL_MINT, r.mint, lamports, r.slippagePct).catch(() => null)]);
    const jupOut = jup ? BigInt(jup.outAmount) : null;
    const market = curve0 ? curvePriceSol(curve0) : undefined;
    if (curve0 && jupOut !== null) {
      const dev = (Number(jupOut) / Number(curveBuyQuote(curve0, lamports) || 1n) - 1) * 100;
      const max = r.maxQuoteDeviationPct ?? WARN_DEVIATION_PCT;
      if (Math.abs(dev) > max) throw new Error(`paper buy: Jupiter-quote wijkt ${dev.toFixed(1)}% af van de on-chain curve (max ${max}%); prijsbronnen lopen uiteen, geen koop`);
    }
    // Transactie "landt" pas na de vertraging: dan geldt de curvestand van dat moment
    const curve = latencyMs > 0 && curve0 ? (await sleep(latencyMs), await this.curve(r.mint)) : curve0;
    const curveOut = curve ? curveBuyQuote(curve, lamports) : null;
    if (curveOut !== null && curveOut > 0n) {
      return { solAmount: r.solAmount + fees, tokenAmountRaw: curveOut, decimals: 6, executor: 'paper/curve', marketPriceSol: market };
    }
    if (jupOut !== null) return { solAmount: r.solAmount + fees, tokenAmountRaw: jupOut, decimals: 6, executor: 'paper/jupiter', marketPriceSol: market };
    const p = this.src.lastPrice(r.mint);
    if (p) {
      const tokens = (r.solAmount / p) * (1 - r.slippagePct / 200);
      return { solAmount: r.solAmount + fees, tokenAmountRaw: BigInt(Math.floor(tokens * 1e6)), decimals: 6, executor: 'paper/price', marketPriceSol: p };
    }
    throw new Error('paper buy: geen quote, curve of prijs beschikbaar');
  }

  async sell(r: SellRequest): Promise<Fill> {
    const fees = this.fees(r.priorityFeeSol);
    const { latencyMs } = this.sim();
    if (latencyMs > 0) await sleep(latencyMs);
    const [curve, jup] = await Promise.all([this.curve(r.mint), jupQuote(r.mint, SOL_MINT, r.tokenAmountRaw, r.slippagePct).catch(() => null)]);
    const curveOut = curve ? curveSellQuote(curve, r.tokenAmountRaw) : null;
    const jupOut = jup ? BigInt(jup.outAmount) : null;
    const market = curve ? curvePriceSol(curve) : undefined;
    let gross: number;
    let via: string;
    if (curveOut !== null && jupOut !== null) {
      const dev = (Number(jupOut) / Number(curveOut || 1n) - 1) * 100;
      if (Math.abs(dev) > WARN_DEVIATION_PCT) {
        const l = shouldLog('paper-sell-dev', 30_000);
        if (l.ok) logger.warn({ mint: r.mint, devPct: dev.toFixed(1), overgeslagen: l.suppressed }, 'paper sell: Jupiter-quote wijkt af van on-chain curve (Jupiter loopt achter); ongunstigste gebruikt');
      }
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
