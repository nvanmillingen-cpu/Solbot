import { describe, expect, it } from 'vitest';
import { evaluateFilters, passesExceptHolders } from '../src/core/filters.js';
import type { TokenMetrics } from '../src/core/metrics.js';
import { defaultSettings } from '../src/settings.js';

const base: TokenMetrics = {
  mint: 'M',
  symbol: 'TST',
  name: 'Test',
  ageMin: 5,
  graduated: false,
  priceSol: 1e-7,
  marketCapUsd: 20_000,
  priceChangePct: 50,
  volumeTotalUsd: 10_000,
  volume10mUsd: 5_000,
  volumeSource: 'dexscreener',
  holders: 30,
  holdersCapped: false,
  liquidityUsd: 3_000,
};

describe('evaluateFilters', () => {
  it('passes a token that meets all defaults', () => {
    const r = evaluateFilters(base, defaultSettings().filters);
    expect(r.pass).toBe(true);
    expect(r.checks.every((c) => c.pass)).toBe(true);
  });

  it('fails on market cap outside range', () => {
    const f = defaultSettings().filters;
    expect(evaluateFilters({ ...base, marketCapUsd: 70_000 }, f).pass).toBe(false);
    expect(evaluateFilters({ ...base, marketCapUsd: 7_000 }, f).pass).toBe(false);
  });

  it('treats unknown data as failing', () => {
    const r = evaluateFilters({ ...base, volume10mUsd: null }, defaultSettings().filters);
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.key === 'volume10m')?.value).toBe('onbekend');
  });

  it('ignores disabled filters', () => {
    const f = defaultSettings().filters;
    f.volume10m.enabled = false;
    f.priceChange.enabled = false;
    const r = evaluateFilters({ ...base, volume10mUsd: 0, priceChangePct: -90 }, f);
    expect(r.pass).toBe(true);
    expect(r.checks.map((c) => c.key)).not.toContain('volume10m');
  });

  it('respects the graduated setting', () => {
    const f = defaultSettings().filters;
    f.graduated = 'yes';
    expect(evaluateFilters(base, f).pass).toBe(false);
    expect(evaluateFilters({ ...base, graduated: true }, f).pass).toBe(true);
    f.graduated = 'any';
    expect(evaluateFilters(base, f).checks.map((c) => c.key)).not.toContain('graduated');
  });

  it('treats max market cap 0 as unlimited', () => {
    const f = defaultSettings().filters;
    f.marketCap.maxUsd = 0;
    expect(evaluateFilters({ ...base, marketCapUsd: 5_000_000 }, f).pass).toBe(true);
  });

  it('allows a lazy holders lookup when only holders are missing', () => {
    const f = defaultSettings().filters;
    f.minHolders.enabled = true;
    const r = evaluateFilters({ ...base, holders: null }, f);
    expect(r.pass).toBe(false);
    expect(passesExceptHolders(r)).toBe(true);
  });
});
