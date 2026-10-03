import type { Settings } from '../settings.js';
import type { PricePoint } from './metrics.js';

/** Vensters (seconden vóór de aankoop) waarover het momentum gemeten wordt. */
export const MOMENTUM_WINDOWS = [60, 30, 10, 1] as const;

export interface Momentum {
  /** Prijsverandering in % over de laatste 60 / 30 / 10 / 1 s; null = te weinig koersdata. */
  m60: number | null;
  m30: number | null;
  m10: number | null;
  m1: number | null;
}

/** Laatst bekende prijs op of vóór tijdstip `t` (een ongewijzigde prijs wordt niet opnieuw opgeslagen). */
function priceAtOrBefore(prices: PricePoint[], t: number): number | null {
  for (let i = prices.length - 1; i >= 0; i--) if (prices[i].t <= t) return prices[i].priceSol;
  return null;
}

/** Momentum op moment `now` met prijs `nowPrice`, uit de prijsgeschiedenis van het token. */
export function computeMomentum(prices: PricePoint[], nowPrice: number | null, now: number): Momentum {
  const at = (sec: number) => {
    const ref = priceAtOrBefore(prices, now - sec * 1000);
    return ref && nowPrice ? +((nowPrice / ref - 1) * 100).toFixed(2) : null;
  };
  return { m60: at(60), m30: at(30), m10: at(10), m1: at(1) };
}

/**
 * Momentumfilter vlak vóór de aankoop. Een uptrend = elk venster BOVEN zijn minimum
 * (standaard > 0%: de koers stijgt over 60, 30, 10 én 1 s). Doel: niet in een downtrend kopen
 * en dan binnen 10 s door de stop-loss verkocht worden. Daalt een kort venster terwijl
 * de lange nog stijgt, dan is er al een reversal en wordt niet gekocht. Te veel momentum
 * (boven het maximum over 60 s) is ook een reden om niet te kopen: dan koop je de top.
 * Onbekend (te weinig koersdata) = niet kopen.
 */
export function evaluateMomentum(m: Momentum, f: Settings['filters']['momentum']): { ok: boolean; reasons: string[] } {
  if (!f.enabled) return { ok: true, reasons: [] };
  const reasons: string[] = [];
  const rules: [keyof Momentum, number, string][] = [
    ['m60', f.min60sPct, '60 s'],
    ['m30', f.min30sPct, '30 s'],
    ['m10', f.min10sPct, '10 s'],
    ['m1', f.min1sPct, '1 s'],
  ];
  for (const [k, min, label] of rules) {
    const v = m[k];
    if (v === null) reasons.push(`momentum ${label} onbekend (te weinig koersdata)`);
    else if (v <= min) reasons.push(`momentum ${label} ${v.toFixed(2)}% ≤ ${min}% (${v < 0 ? 'reversal' : v === 0 ? 'geen stijging' : 'te zwak'})`);
  }
  if (f.max60sPct > 0 && m.m60 !== null && m.m60 > f.max60sPct) reasons.push(`momentum 60 s ${m.m60.toFixed(1)}% > ${f.max60sPct}% (te hard gestegen)`);
  return { ok: reasons.length === 0, reasons };
}
