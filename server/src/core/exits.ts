import type { Settings } from '../settings.js';

export type ExitReason = 'SL' | 'TP' | 'TIME' | 'TRAIL' | 'MANUAL' | 'SELL_ALL' | 'INIT' | 'PTP';

export const EXIT_LABELS: Record<ExitReason, string> = {
  SL: 'Stop-loss',
  TP: 'Take-profit',
  TIME: 'Max. houdtijd',
  TRAIL: 'Trailing stop',
  MANUAL: 'Handmatig',
  SELL_ALL: 'Sell all',
  INIT: 'Inzet eruit',
  PTP: 'Deel take-profit',
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
 * Binnen de grace period na aankoop vuurt de stop-loss alleen bij een harde daling (noodstop).
 */
export function evaluateExit(p: ExitInput, priceSol: number | null, now: number, exits: Settings['exits']): ExitReason | null {
  if (priceSol !== null && priceSol > 0 && p.entryPriceSol > 0) {
    const pnlPct = (priceSol / p.entryPriceSol - 1) * 100;
    if (exits.stopLoss.enabled) {
      const inGrace = now - p.openedAt < exits.stopLoss.graceSec * 1000;
      const slPct = inGrace ? Math.max(exits.stopLoss.pct, exits.stopLoss.graceMaxLossPct) : exits.stopLoss.pct;
      if (pnlPct <= -slPct) return 'SL';
    }
    if (exits.trailingStop.enabled) {
      const peak = Math.max(p.peakPriceSol, p.entryPriceSol, priceSol);
      // Pas actief zodra de piek de activatiedrempel boven de instapprijs heeft gehaald
      const armed = peak >= p.entryPriceSol * (1 + exits.trailingStop.activatePct / 100);
      if (armed && priceSol <= peak * (1 - exits.trailingStop.pct / 100)) return 'TRAIL';
    }
    if (exits.takeProfit.enabled && pnlPct >= exits.takeProfit.pct) return 'TP';
  }
  if (exits.maxHold.enabled && now - p.openedAt >= exits.maxHold.minutes * 60_000) return 'TIME';
  return null;
}

export type PartialKind = 'INIT' | 'PTP';

export interface PartialExit {
  /** Unieke sleutel per niveau; wordt bij de positie opgeslagen zodat een niveau maar één keer verkoopt. */
  key: string;
  kind: PartialKind;
  /** Deel van de resterende tokens dat verkocht moet worden (0–1). */
  fraction: number;
}

export interface PartialInput {
  entryPriceSol: number;
  /** Totale inleg in SOL (incl. fees). */
  entrySol: number;
  /** Al ontvangen SOL uit eerdere deelverkopen (telt mee bij "inzet eruit"). */
  realizedSol?: number;
  /** Resterende tokens (hele tokens). */
  remainingTokens: number;
  /** Al uitgevoerde niveaus. */
  done: string[];
}

/** Marge voor fees en impact bij "inzet eruit": iets meer verkopen dan de inleg puur op marktprijs. */
export const INITIAL_FEE_MARGIN = 1.04;

/**
 * Pure check voor gedeeltelijke verkopen. Geeft het eerstvolgende niveau dat geraakt is,
 * of null. "Inzet eruit" gaat vóór de gedeeltelijke take-profit-niveaus; niveaus gaan op
 * volgorde van winst-%. Per aanroep maximaal één deelverkoop.
 */
export function evaluatePartial(p: PartialInput, priceSol: number | null, exits: Settings['exits']): PartialExit | null {
  if (priceSol === null || priceSol <= 0 || p.entryPriceSol <= 0 || p.remainingTokens <= 0) return null;
  const pnlPct = (priceSol / p.entryPriceSol - 1) * 100;
  // Kleine tolerantie tegen afrondingsfouten (instap 1,0000000000000001e-7 → +99,9999999%)
  const hit = (pct: number) => pnlPct >= pct - 1e-6;
  const ti = exits.takeInitial;
  if (ti.enabled && !p.done.includes('init') && hit(ti.pct)) {
    // Wat al terug is uit eerdere deelverkopen telt mee; is de inleg al terug, dan alleen afvinken (fraction 0)
    const need = Math.max(0, p.entrySol * INITIAL_FEE_MARGIN - (p.realizedSol ?? 0));
    const value = p.remainingTokens * priceSol;
    return { key: 'init', kind: 'INIT', fraction: Math.min(1, need / value) };
  }
  const ptp = exits.partialTakeProfit;
  if (ptp.enabled) {
    const levels = [...ptp.levels].sort((a, b) => a.pct - b.pct);
    for (const l of levels) {
      const key = `tp${l.pct}`;
      if (p.done.includes(key) || !hit(l.pct)) continue;
      return { key, kind: 'PTP', fraction: Math.min(1, l.sellPct / 100) };
    }
  }
  return null;
}
