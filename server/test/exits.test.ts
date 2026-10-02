import { describe, expect, it } from 'vitest';
import { evaluateExit } from '../src/core/exits.js';
import { defaultSettings } from '../src/settings.js';

const exits = () => {
  const e = defaultSettings().exits;
  // Vaste waarden zodat de tests niet afhangen van de standaardinstellingen
  e.stopLoss = { enabled: true, pct: 25, graceSec: 0, graceMaxLossPct: 35 };
  e.takeProfit = { enabled: true, pct: 60 };
  e.maxHold = { enabled: true, minutes: 20 };
  e.trailingStop = { enabled: false, pct: 20, activatePct: 0 };
  return e;
};
const now = 1_000_000_000;
const pos = { entryPriceSol: 1, peakPriceSol: 1, openedAt: now - 60_000 };

describe('evaluateExit', () => {
  it('returns null while within all limits', () => {
    expect(evaluateExit(pos, 1.1, now, exits())).toBeNull();
  });

  it('triggers stop-loss', () => {
    expect(evaluateExit(pos, 0.75, now, exits())).toBe('SL');
    expect(evaluateExit(pos, 0.76, now, exits())).toBeNull();
  });

  it('triggers take-profit', () => {
    expect(evaluateExit(pos, 1.6, now, exits())).toBe('TP');
  });

  it('triggers max hold time, even without a price', () => {
    const p = { ...pos, openedAt: now - 21 * 60_000 };
    expect(evaluateExit(p, 1, now, exits())).toBe('TIME');
    expect(evaluateExit(p, null, now, exits())).toBe('TIME');
  });

  it('trailing stop follows the peak since purchase', () => {
    const e = exits();
    e.trailingStop.enabled = true;
    e.trailingStop.pct = 20;
    e.takeProfit.enabled = false;
    const p = { ...pos, peakPriceSol: 2 };
    expect(evaluateExit(p, 1.7, now, e)).toBeNull();
    expect(evaluateExit(p, 1.6, now, e)).toBe('TRAIL');
  });

  it('stop-loss wins over trailing when both hit', () => {
    const e = exits();
    e.trailingStop.enabled = true;
    expect(evaluateExit(pos, 0.5, now, e)).toBe('SL');
  });

  it('disabled rules never fire', () => {
    const e = exits();
    e.stopLoss.enabled = false;
    e.takeProfit.enabled = false;
    e.maxHold.enabled = false;
    expect(evaluateExit({ ...pos, openedAt: 0 }, 0.01, now, e)).toBeNull();
    expect(evaluateExit(pos, 100, now, e)).toBeNull();
  });
});

describe('trailing stop met activatiedrempel', () => {
  const e = () => {
    const x = exits();
    x.trailingStop = { enabled: true, pct: 15, activatePct: 20 };
    x.takeProfit.enabled = false;
    return x;
  };

  it('vuurt niet op ruis vlak na aankoop (vroeger direct TRAIL)', () => {
    // -15% vlak na de koop: met activatie 20% geen trailing stop, SL (25%) ook nog niet
    expect(evaluateExit({ ...pos, peakPriceSol: 1.02 }, 0.85, now, e())).toBeNull();
  });

  it('wordt pas actief als de piek de activatiedrempel haalt', () => {
    expect(evaluateExit({ ...pos, peakPriceSol: 1.19 }, 1.0, now, e())).toBeNull();
    // piek 1,30 → actief; 15% eronder = 1,105
    expect(evaluateExit({ ...pos, peakPriceSol: 1.3 }, 1.11, now, e())).toBeNull();
    expect(evaluateExit({ ...pos, peakPriceSol: 1.3 }, 1.1, now, e())).toBe('TRAIL');
  });

  it('beschermt winst: na activatie eindigt een trail-exit boven instap', () => {
    // Slechtste geval: piek precies op 1,20, daarna 15% eraf → 1,02 (boven instap)
    expect(evaluateExit({ ...pos, peakPriceSol: 1.2 }, 1.02, now, e())).toBe('TRAIL');
  });

  it('activatie 0 = oude gedrag (direct vanaf aankoop)', () => {
    const x = e();
    x.trailingStop.activatePct = 0;
    expect(evaluateExit({ ...pos, peakPriceSol: 1.0 }, 0.85, now, x)).toBe('TRAIL');
  });

  it('stop-loss blijft werken als de trail nog niet actief is', () => {
    expect(evaluateExit({ ...pos, peakPriceSol: 1.05 }, 0.7, now, e())).toBe('SL');
  });
});

describe('stop-loss grace period (SL binnen ~1 s na koop)', () => {
  const e = () => {
    const x = exits();
    x.stopLoss = { enabled: true, pct: 15, graceSec: 3, graceMaxLossPct: 35 };
    return x;
  };
  const fresh = { entryPriceSol: 1, peakPriceSol: 1, openedAt: now - 500 };

  it('geen gewone SL in de eerste seconden (si.gov/CLIPPY: -16% na 0,5 s)', () => {
    expect(evaluateExit(fresh, 0.84, now, e())).toBeNull();
  });

  it('noodstop vuurt wel binnen de grace period', () => {
    expect(evaluateExit(fresh, 0.65, now, e())).toBe('SL');
  });

  it('na de grace period geldt de normale SL weer', () => {
    expect(evaluateExit({ ...fresh, openedAt: now - 3000 }, 0.84, now, e())).toBe('SL');
  });

  it('noodstop nooit soepeler dan de gewone SL', () => {
    const x = e();
    x.stopLoss.graceMaxLossPct = 10; // lager dan SL 15%: dan geldt 15%
    expect(evaluateExit(fresh, 0.88, now, x)).toBeNull();
    expect(evaluateExit(fresh, 0.85, now, x)).toBe('SL');
  });
});
