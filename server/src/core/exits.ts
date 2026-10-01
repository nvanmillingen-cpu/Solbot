import type { Settings } from '../settings.js';

export type ExitReason = 'SL' | 'TP' | 'TIME' | 'TRAIL' | 'MANUAL' | 'SELL_ALL';

export const EXIT_LABELS: Record<ExitReason, string> = {
  SL: 'Stop-loss',
  TP: 'Take-profit',
  TIME: 'Max. houdtijd',
  TRAIL: 'Trailing stop',
  MANUAL: 'Handmatig',
  SELL_ALL: 'Sell all',
};

export interface ExitInput {
  entryPriceSol: number;
  /** Hoogste prijs sinds aankoop (inclusief de huidige). */
  peakPriceSol: number;
  openedAt: number;
}

/**
 * Pure exit-check. Volgorde bij meerdere treffers: SL, TRAIL, TP, TIME.
 * `priceSol` mag null zijn (geen prijs): dan kan alleen TIME triggeren.
 */
export function evaluateExit(p: ExitInput, priceSol: number | null, now: number, exits: Settings['exits']): ExitReason | null {
  if (priceSol !== null && priceSol > 0 && p.entryPriceSol > 0) {
    const pnlPct = (priceSol / p.entryPriceSol - 1) * 100;
    if (exits.stopLoss.enabled && pnlPct <= -exits.stopLoss.pct) return 'SL';
    if (exits.trailingStop.enabled) {
      const peak = Math.max(p.peakPriceSol, p.entryPriceSol, priceSol);
      if (priceSol <= peak * (1 - exits.trailingStop.pct / 100)) return 'TRAIL';
    }
    if (exits.takeProfit.enabled && pnlPct >= exits.takeProfit.pct) return 'TP';
  }
  if (exits.maxHold.enabled && now - p.openedAt >= exits.maxHold.minutes * 60_000) return 'TIME';
  return null;
}
