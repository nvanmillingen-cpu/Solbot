import { describe, expect, it } from 'vitest';
import { addPrice, computeMetrics, newTrackedToken } from '../src/core/metrics.js';
import type { DexInfo } from '../src/market/dexscreener.js';

const SOL_USD = 100;
const now = 10_000_000;
const min = 60_000;

describe('computeMetrics', () => {
  it('uses launch price for young tokens and computes market cap', () => {
    const t = newTrackedToken({ mint: 'A', source: 'new', createdAt: now - 3 * min, firstSeenAt: now - 3 * min, launchPriceSol: 1e-8 });
    addPrice(t, { t: now - 3 * min, priceSol: 1e-8 });
    addPrice(t, { t: now, priceSol: 1.5e-8 });
    const m = computeMetrics(t, now, SOL_USD, 10);
    expect(m.priceChangePct).toBeCloseTo(50, 5);
    expect(m.marketCapUsd).toBeCloseTo(1.5e-8 * 1e9 * SOL_USD, 5);
    expect(m.ageMin).toBeCloseTo(3, 5);
  });

  it('measures change over the window for older tokens', () => {
    const t = newTrackedToken({ mint: 'A', source: 'new', createdAt: now - 30 * min, firstSeenAt: now - 30 * min, launchPriceSol: 1e-9 });
    addPrice(t, { t: now - 30 * min, priceSol: 1e-9 });
    addPrice(t, { t: now - 10 * min + 5_000, priceSol: 2e-8 });
    addPrice(t, { t: now, priceSol: 3e-8 });
    expect(computeMetrics(t, now, SOL_USD, 10).priceChangePct).toBeCloseTo(50, 5);
  });

  it('estimates volume from curve changes and initial buy', () => {
    const t = newTrackedToken({ mint: 'A', source: 'new', createdAt: now - 20 * min, initialBuySol: 1 });
    t.curveVolume.push({ t: now - 15 * min, sol: 2 }, { t: now - 5 * min, sol: 3 });
    t.curve = { virtualTokenReserves: 1n, virtualSolReserves: 1n, realTokenReserves: 1n, realSolReserves: 5_000_000_000n, tokenTotalSupply: 1n, complete: false };
    const m = computeMetrics(t, now, SOL_USD, 10);
    expect(m.volumeSource).toBe('curve');
    expect(m.volumeTotalUsd).toBe(600);
    expect(m.volume10mUsd).toBe(300);
    expect(m.liquidityUsd).toBe(500);
  });

  it('takes the larger of DexScreener and curve volume, 10 min via h24 snapshots', () => {
    const t = newTrackedToken({ mint: 'A', source: 'new', createdAt: now - 60 * min });
    t.curveVolume.push({ t: now - min, sol: 1 });
    t.dex = { volumeUsd: { m5: 50, h1: 4000, h6: 0, h24: 5000 }, priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 } } as DexInfo;
    t.dexVolSnapshots.push({ t: now - 11 * min, h24: 4200 }, { t: now, h24: 5000 });
    const m = computeMetrics(t, now, SOL_USD, 10);
    expect(m.volumeSource).toBe('dexscreener');
    expect(m.volumeTotalUsd).toBe(5000);
    expect(m.volume10mUsd).toBe(800);
  });

  it('uses exact trades and holder balances when the trade stream is available', () => {
    const t = newTrackedToken({ mint: 'A', source: 'new', createdAt: now - 20 * min, initialBuySol: 1, tradeStream: true });
    t.trades.push({ t: now - 15 * min, sol: 2 }, { t: now - 2 * min, sol: 4 });
    t.balances.set('a', 10).set('b', 0).set('c', 5);
    const m = computeMetrics(t, now, SOL_USD, 10);
    expect(m.volumeSource).toBe('trades');
    expect(m.volumeTotalUsd).toBe(700);
    expect(m.volume10mUsd).toBe(400);
    expect(m.holders).toBe(2);
  });

  it('reports unknown when there is no data', () => {
    const t = newTrackedToken({ mint: 'A', source: 'migration' });
    const m = computeMetrics(t, now, SOL_USD, 10);
    expect(m.volumeTotalUsd).toBeNull();
    expect(m.priceChangePct).toBeNull();
    expect(m.holders).toBeNull();
  });
});
