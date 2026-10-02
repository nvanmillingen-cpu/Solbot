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
  onCurve: true,
  mayhem: false,
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

describe('bonding-curve-, mayhem- en max-stijgingfilter', () => {
  it('"alleen bonding curve" vereist een gevonden, niet-voltooide curve', () => {
    const f = defaultSettings().filters; // graduated: 'no'
    expect(evaluateFilters({ ...base, onCurve: true }, f).pass).toBe(true);
    const unknown = evaluateFilters({ ...base, onCurve: null }, f);
    expect(unknown.pass).toBe(false);
    expect(unknown.checks.find((c) => c.key === 'graduated')?.value).toBe('onbekend');
    expect(evaluateFilters({ ...base, onCurve: false }, f).pass).toBe(false);
  });

  it('slaat mayhem-mode-tokens standaard over', () => {
    const f = defaultSettings().filters;
    expect(f.excludeMayhem).toBe(true);
    expect(evaluateFilters({ ...base, mayhem: true }, f).pass).toBe(false);
    f.excludeMayhem = false;
    expect(evaluateFilters({ ...base, mayhem: true }, f).pass).toBe(true);
  });

  it('maximale stijging sluit late pumps uit (0 = geen maximum)', () => {
    const f = defaultSettings().filters;
    expect(f.priceChange.maxPct).toBe(0);
    expect(evaluateFilters({ ...base, priceChangePct: 850 }, f).pass).toBe(true);
    f.priceChange.maxPct = 150;
    expect(evaluateFilters({ ...base, priceChangePct: 850 }, f).pass).toBe(false);
    expect(evaluateFilters({ ...base, priceChangePct: 150 }, f).pass).toBe(true);
    expect(evaluateFilters({ ...base, priceChangePct: 20 }, f).pass).toBe(false);
  });
});
