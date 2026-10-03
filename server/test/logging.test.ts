import { describe, expect, it, vi } from 'vitest';
import { computeMomentum, evaluateMomentum } from '../src/core/momentum.js';
import { defaultSettings, diffSettings, migrateSettings, settingsSchema } from '../src/settings.js';

const now = 10_000_000;
/** Prijsreeks: 100 → 110 → 120 → 130 → 128 (reversal in de laatste seconde). */
const prices = [
  { t: now - 70_000, priceSol: 100 },
  { t: now - 30_000, priceSol: 110 },
  { t: now - 10_000, priceSol: 120 },
  { t: now - 1_000, priceSol: 130 },
];

describe('momentum', () => {
  it('meet de prijsverandering per venster', () => {
    const m = computeMomentum(prices, 128, now);
    expect(m.m60).toBeCloseTo(28, 1); // t-60s → prijs van t-70s (100)
    expect(m.m30).toBeCloseTo((128 / 110 - 1) * 100, 1);
    expect(m.m10).toBeCloseTo((128 / 120 - 1) * 100, 1);
    expect(m.m1).toBeCloseTo((128 / 130 - 1) * 100, 1);
  });

  it('vlak (0%) telt niet als uptrend: elk venster moet positief zijn', () => {
    const r = evaluateMomentum({ m60: 30, m30: 10, m10: 2, m1: 0 }, { ...defaultSettings().filters.momentum, enabled: true });
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/1 s .*geen stijging/);
  });

  it('te weinig koersdata = onbekend', () => {
    expect(computeMomentum([{ t: now - 5_000, priceSol: 1 }], 1, now).m60).toBeNull();
  });

  const f = () => ({ ...defaultSettings().filters.momentum, enabled: true });

  it('uptrend op alle vensters → kopen', () => {
    expect(evaluateMomentum({ m60: 30, m30: 12, m10: 5, m1: 0.5 }, f()).ok).toBe(true);
  });

  it('reversal: lange vensters stijgen, laatste seconde daalt → niet kopen', () => {
    const r = evaluateMomentum(computeMomentum(prices, 128, now), f());
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/1 s .*reversal/);
  });

  it('meer dan 70% in de laatste minuut → niet kopen', () => {
    const r = evaluateMomentum({ m60: 85, m30: 40, m10: 10, m1: 1 }, f());
    expect(r.reasons.join()).toMatch(/te hard gestegen/);
  });

  it('onbekend → niet kopen (fail-closed); uit → altijd ok', () => {
    expect(evaluateMomentum({ m60: null, m30: 1, m10: 1, m1: 1 }, f()).ok).toBe(false);
    expect(evaluateMomentum({ m60: null, m30: -50, m10: -50, m1: -50 }, defaultSettings().filters.momentum).ok).toBe(true);
  });
});

describe('instellingen', () => {
  it('oude slippage wordt aankoop- én verkoopslippage', () => {
    const s = settingsSchema.parse(migrateSettings({ general: { slippagePct: 25 } }));
    expect(s.general.buySlippagePct).toBe(25);
    expect(s.general.sellSlippagePct).toBe(25);
  });

  it('diff laat precies zien wat er veranderde', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    b.exits.stopLoss.pct = 12;
    b.general.sellSlippagePct = 30;
    expect(diffSettings(a, b)).toEqual({ 'exits.stopLoss.pct': '20 → 12', 'general.sellSlippagePct': '15 → 30' });
  });
});

describe('koerspad, tijd boven drempels, stap-tijdstempels en P&L per deel', async () => {
  const { openDb } = await import('../src/db.js');
  const { PositionManager, updatePath } = await import('../src/core/positions.js');

  it('updatePath vult elk meetmoment met de eerste prijs erna', () => {
    let p = updatePath(null, 0, 1, 1200);
    expect(JSON.parse(p!)).toEqual({ 1: { p: 1, t: 1.2 } });
    p = updatePath(p, 0, 2, 5500);
    expect(Object.keys(JSON.parse(p!))).toEqual(['1', '3', '5']);
    expect(updatePath(p, 0, 3, 5800)).toBeNull();
  });

  it('volledige flow', async () => {
    const db = openDb(':memory:');
    const tracker = { tokens: new Map(), pinned: new Set<string>(), ensure: () => ({}), markGraduated: () => undefined } as never;
    let price = 1e-7;
    const exec = {
      name: 'test',
      buy: vi.fn(),
      sell: vi.fn(async (r: { tokenAmountRaw: bigint }) => ({ solAmount: (Number(r.tokenAmountRaw) / 1e6) * price, tokenAmountRaw: r.tokenAmountRaw, decimals: 6, executor: 'test', sentAt: 1, landedAt: 2 })),
    };
    const s = defaultSettings();
    s.exits.takeProfit.enabled = false;
    s.exits.trailingStop.enabled = false;
    s.exits.partialTakeProfit = { enabled: true, levels: [{ pct: 50, sellPct: 50 }] };
    const pm = new PositionManager(db, { removeAccountChangeListener: async () => undefined } as never, tracker, () => s, () => exec);
    const t0 = Date.now();
    const pos = pm.record({
      mint: 'M',
      symbol: 'M',
      name: '',
      mode: 'paper',
      graduated: false,
      fill: { solAmount: 0.05, tokenAmountRaw: 500_000_000_000n, decimals: 6, executor: 'test', sentAt: t0 - 1500, landedAt: t0 },
      entry: {
        ageMin: 3, mcapUsd: 1, volTotalUsd: 1, vol10mUsd: 1, priceChangePct: 1, holders: 30, top10Pct: 20, creatorPct: 1, rtLossPct: 2,
        evalAt: t0 - 2000, evalPriceSol: 0.95e-7, checkAt: t0 - 1700, checkPriceSol: 0.97e-7, sentAt: t0 - 1500, sentPriceSol: 0.97e-7, landedAt: t0, landedPriceSol: 0.99e-7,
        momentum: { m60: 30, m30: 10, m10: 4, m1: 0.5 },
      },
    });
    expect(pos.check_price_sol).toBe(0.97e-7);
    expect(pos.mom_60s_pct).toBe(30);
    const h = (p: number, at: number) => (pm as unknown as { handlePrice: (r: unknown, p: number, n: number) => void }).handlePrice(pm.get(pos.id), p, at);
    // +25% op t+1 s, +30% op t+5 s, +55% op t+11 s (deel-TP), daarna eindverkoop
    h(1.25e-7, t0 + 1000);
    h(1.3e-7, t0 + 5000);
    price = 1.55e-7;
    h(price, t0 + 11_000);
    await new Promise((r) => setTimeout(r, 10));
    let r = pm.get(pos.id)!;
    expect(r.secs_above_20).toBeCloseTo(10, 6); // van t+1 tot t+11 boven +20%
    expect(r.first_20_at).toBe(t0 + 1000);
    expect(r.first_50_at).toBe(t0 + 11_000);
    expect(Object.keys(JSON.parse(r.path_json!))).toEqual(['1', '3', '5', '10']);
    expect(r.partial_done).toBe('tp50');
    price = 1.2e-7;
    await pm.sell(pos.id, 'MANUAL');
    const sells = pm.sellsForExport();
    expect(sells.map((x) => x.soort)).toEqual(['PTP', 'MANUAL']);
    expect(Number(sells[0].pnl_pct)).toBeCloseTo(55, 0); // deel verkocht op +55%
    expect(Number(sells[1].pnl_pct)).toBeCloseTo(20, 0); // rest op +20%
    const csv = pm.allForExport()[0];
    expect(csv.koers_1s_pct).toBeCloseTo(25, 1);
    expect(csv.koers_30s_pct).toBeNull();
    expect(csv.momentum_60s_pct).toBe(30);
    expect(Number(csv.check_vs_evaluatie_pct)).toBeCloseTo((0.97 / 0.95 - 1) * 100, 1);
    expect(csv.evaluatie_naar_landing_ms).toBe(2000);
    r = pm.get(pos.id)!;
    expect(r.config_hash).toBeNull(); // in deze test niet meegegeven; in de bot altijd gevuld
  });
});

describe('overgeslagen tokens (counterfactual)', async () => {
  const { openDb } = await import('../src/db.js');
  const { SkipLog } = await import('../src/core/skipped.js');
  it('legt één keer vast per token en reden, en volgt de koers', () => {
    const db = openDb(':memory:');
    const token = { mint: 'S', prices: [{ t: 0, priceSol: 2 }], graduated: false };
    const tracker = { tokens: new Map([['S', token]]), keepAlive: [] as ((m: string) => boolean)[], ensure: () => token } as never;
    const log = new SkipLog(db, tracker, () => 15, () => 'abc');
    const m = { mint: 'S', symbol: 'S', priceSol: 1, ageMin: 3, marketCapUsd: 9000, volumeTotalUsd: 5000, volume10mUsd: 3000, priceChangePct: 40, holders: 22 } as never;
    expect(log.record(m, { stage: 'filter', reasonKey: 'volume10m', reason: 'Volume 10 min: $3.000 (nodig ≥ $4.000)', value: '$3.000', required: '≥ $4.000', momentum: { m60: 12, m30: 5, m10: 1, m1: 0 } })).toBe(true);
    expect(log.record(m, { stage: 'filter', reasonKey: 'volume10m', reason: 'nogmaals' })).toBe(false);
    expect((tracker as unknown as { keepAlive: ((m: string) => boolean)[] }).keepAlive[0]('S')).toBe(true);
    log.tick();
    const row = log.forExport()[0];
    expect(row.fase).toBe('filter');
    expect(row.max_na_afwijzing_pct).toBe(100); // 1 → 2
    expect(row.momentum_60s_pct).toBe(12);
    expect(row.config_hash).toBe('abc');
  });
});
