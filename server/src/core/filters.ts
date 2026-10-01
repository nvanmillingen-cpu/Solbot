import type { Settings } from '../settings.js';
import type { TokenMetrics } from './metrics.js';

export interface FilterCheck {
  key: string;
  label: string;
  pass: boolean;
  value: string;
  required: string;
}

export interface FilterResult {
  pass: boolean;
  checks: FilterCheck[];
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('nl-NL')}`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const UNKNOWN = 'onbekend';

/**
 * Pure filterengine: geeft per ingeschakeld filter aan of het token voldoet.
 * Onbekende data telt als NIET voldoen (veiliger).
 */
export function evaluateFilters(m: TokenMetrics, f: Settings['filters']): FilterResult {
  const checks: FilterCheck[] = [];
  const add = (key: string, label: string, pass: boolean, value: string, required: string) =>
    checks.push({ key, label, pass, value, required });

  if (f.priceChange.enabled) {
    const v = m.priceChangePct;
    add('priceChange', `Stijging (${f.priceChange.windowMin} min)`, v !== null && v >= f.priceChange.minPct, v === null ? UNKNOWN : pct(v), `≥ ${pct(f.priceChange.minPct)}`);
  }
  if (f.volumeTotal.enabled) {
    const v = m.volumeTotalUsd;
    add('volumeTotal', 'Volume totaal', v !== null && v >= f.volumeTotal.minUsd, v === null ? UNKNOWN : usd(v), `≥ ${usd(f.volumeTotal.minUsd)}`);
  }
  if (f.volume10m.enabled) {
    const v = m.volume10mUsd;
    add('volume10m', 'Volume 10 min', v !== null && v >= f.volume10m.minUsd, v === null ? UNKNOWN : usd(v), `≥ ${usd(f.volume10m.minUsd)}`);
  }
  if (f.marketCap.enabled) {
    const v = m.marketCapUsd;
    const max = f.marketCap.maxUsd > 0 ? f.marketCap.maxUsd : Infinity;
    add(
      'marketCap',
      'Market cap',
      v !== null && v >= f.marketCap.minUsd && v <= max,
      v === null ? UNKNOWN : usd(v),
      `${usd(f.marketCap.minUsd)} – ${max === Infinity ? '∞' : usd(max)}`,
    );
  }
  if (f.graduated !== 'any') {
    const want = f.graduated === 'yes';
    add('graduated', 'Graduated', m.graduated === want, m.graduated ? 'ja' : 'nee', want ? 'ja' : 'nee');
  }
  if (f.minAge.enabled) {
    const v = m.ageMin;
    add('minAge', 'Min. leeftijd', v !== null && v >= f.minAge.minutes, v === null ? UNKNOWN : `${v.toFixed(1)} min`, `≥ ${f.minAge.minutes} min`);
  }
  if (f.maxAge.enabled) {
    const v = m.ageMin;
    add('maxAge', 'Max. leeftijd', v !== null && v <= f.maxAge.minutes, v === null ? UNKNOWN : `${v.toFixed(1)} min`, `≤ ${f.maxAge.minutes} min`);
  }
  if (f.minHolders.enabled) {
    const v = m.holders;
    // Een afgetopte telling (RPC: max 20) is alleen bruikbaar als hij al hoog genoeg is.
    const pass = v !== null && v >= f.minHolders.count;
    add('minHolders', 'Holders', pass, v === null ? UNKNOWN : `${v}${m.holdersCapped ? '+' : ''}`, `≥ ${f.minHolders.count}`);
  }

  return { pass: checks.every((c) => c.pass), checks };
}

/** True als alle filters behalve holders slagen (holders wordt lui via RPC opgehaald). */
export function passesExceptHolders(r: FilterResult): boolean {
  return r.checks.every((c) => c.pass || c.key === 'minHolders');
}
