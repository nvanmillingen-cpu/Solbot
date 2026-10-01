import { describe, expect, it } from 'vitest';
import { evaluateExit } from '../src/core/exits.js';
import { defaultSettings } from '../src/settings.js';

const exits = () => {
  const e = defaultSettings().exits;
  // Vaste waarden zodat de tests niet afhangen van de standaardinstellingen
  e.stopLoss = { enabled: true, pct: 25 };
  e.takeProfit = { enabled: true, pct: 60 };
  e.maxHold = { enabled: true, minutes: 20 };
  e.trailingStop = { enabled: false, pct: 20 };
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
