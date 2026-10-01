import { describe, expect, it } from 'vitest';
import { computeStats, pnlSeries } from '../src/core/stats.js';
import { SettingsStore, defaultSettings } from '../src/settings.js';
import { openDb } from '../src/db.js';

describe('stats', () => {
  const trades = [
    { closed_at: 1000, pnl_sol: 0.02, pnl_pct: 40 },
    { closed_at: 2000, pnl_sol: -0.01, pnl_pct: -20 },
    { closed_at: 3000, pnl_sol: -0.005, pnl_pct: -10 },
  ];

  it('computes win rate and averages', () => {
    const s = computeStats(trades);
    expect(s.totalTrades).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(2);
    expect(s.winRatePct).toBeCloseTo(33.33, 1);
    expect(s.avgPnlPct).toBeCloseTo(10 / 3, 5);
    expect(s.totalPnlSol).toBeCloseTo(0.005, 10);
    expect(s.bestPct).toBe(40);
    expect(s.worstPct).toBe(-20);
  });

  it('handles no trades', () => {
    expect(computeStats([])).toMatchObject({ totalTrades: 0, winRatePct: 0, bestPct: null });
  });

  it('builds a cumulative series starting at zero', () => {
    const s = pnlSeries(trades, 1500, 5000);
    expect(s.map((p) => p.t)).toEqual([1500, 2000, 3000, 5000]);
    expect(s.at(-1)!.cumPnlSol).toBeCloseTo(-0.015, 10);
  });
});

describe('SettingsStore', () => {
  it('merges partial updates and persists them', () => {
    const db = openDb(':memory:');
    const store = new SettingsStore(db);
    expect(store.get()).toEqual(defaultSettings());
    store.update({ filters: { marketCap: { maxUsd: 99_000 } } });
    expect(store.get().filters.marketCap).toEqual({ enabled: true, minUsd: 8000, maxUsd: 99_000 });
    expect(new SettingsStore(db).get().filters.marketCap.maxUsd).toBe(99_000);
  });

  it('rejects invalid values and keeps the old settings', () => {
    const store = new SettingsStore(openDb(':memory:'));
    expect(() => store.update({ risk: { solPerTrade: -1 } })).toThrow();
    expect(store.get().risk.solPerTrade).toBe(0.05);
  });
});
