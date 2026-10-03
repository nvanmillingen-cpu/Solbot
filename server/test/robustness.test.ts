import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/market/jupiter.js', () => ({
  jupQuote: vi.fn(async () => {
    throw new Error('geen route');
  }),
  jupPricesUsd: vi.fn(async () => new Map()),
}));

const { openDb } = await import('../src/db.js');
const { PositionManager } = await import('../src/core/positions.js');
const { configHash, defaultSettings, SettingsStore } = await import('../src/settings.js');
const { Health } = await import('../src/core/health.js');
const { shouldLog } = await import('../src/logger.js');
const { PaperExecutor } = await import('../src/executor/paper.js');
const { curveBuyQuote } = await import('../src/market/bondingCurve.js');

const fill = { solAmount: 0.0505, tokenAmountRaw: 1_000_000_000_000n, decimals: 6, executor: 'paper/curve', marketPriceSol: 4.9e-8 };

function setup(sellDelayMs = 50) {
  const db = openDb(':memory:');
  const tracker = { tokens: new Map(), pinned: new Set<string>(), ensure: () => ({}), markGraduated: () => undefined } as never;
  const exec = {
    name: 'paper',
    buy: vi.fn(),
    sell: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, sellDelayMs));
      return { ...fill, solAmount: 0.06 };
    }),
  };
  const pm = new PositionManager(db, { removeAccountChangeListener: async () => undefined } as never, tracker, defaultSettings, () => exec);
  return { db, pm, exec };
}

describe('closing-lock (inumas #72: twee exit-triggers binnen 190 ms)', () => {
  it('twee gelijktijdige verkopen → maar één echte verkoop', async () => {
    const { pm, exec } = setup();
    const pos = pm.record({ mint: 'INU', symbol: 'inumas', name: '', mode: 'paper', fill, graduated: false });
    const [a, b] = await Promise.all([pm.sell(pos.id, 'TRAIL', 6e-8), pm.sell(pos.id, 'TRAIL', 5.9e-8)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(exec.sell).toHaveBeenCalledTimes(1);
  });

  it('na sluiten kan een verouderde trigger niet opnieuw verkopen', async () => {
    const { pm, exec } = setup(0);
    const pos = pm.record({ mint: 'INU', symbol: 'inumas', name: '', mode: 'paper', fill, graduated: false });
    expect(await pm.sell(pos.id, 'TRAIL')).toBe(true);
    expect(await pm.sell(pos.id, 'TRAIL')).toBe(false);
    expect(exec.sell).toHaveBeenCalledTimes(1);
  });
});

describe('MFE/MAE en experimenthygiëne', () => {
  it('slaat config-hash, run-id, min/max tijdens houden en het na-exit-venster op', async () => {
    const { pm } = setup(0);
    const pos = pm.record({ mint: 'X', symbol: 'X', name: '', mode: 'paper', fill, graduated: false, configHash: 'abcd1234' });
    expect(pos.config_hash).toBe('abcd1234');
    expect(pos.run_id).toMatch(/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/);
    expect(pos.min_price_sol).toBe(pos.entry_price_sol);
    const h = (pm as unknown as { handlePrice: (r: unknown, p: number, n: number) => void }).handlePrice.bind(pm);
    const entry = pos.entry_price_sol;
    h(pm.get(pos.id), entry * 1.1, Date.now());
    h(pm.get(pos.id), entry * 0.95, Date.now());
    const r = pm.get(pos.id)!;
    expect(r.peak_price_sol).toBeCloseTo(entry * 1.1, 18);
    expect(r.min_price_sol).toBeCloseTo(entry * 0.95, 18);
    expect(r.peak_price_at).not.toBeNull();
    await pm.sell(pos.id, 'MANUAL');
    const closed = pm.get(pos.id)!;
    expect(closed.post_watch_until).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(closed.post_graduated).toBe(0);
    expect(pm.watched().map((w) => w.id)).toContain(pos.id);
    const csv = pm.allForExport()[0];
    expect(csv.max_tijdens_pct).toBeCloseTo(10, 1);
    expect(csv.min_tijdens_pct).toBeCloseTo(-5, 1);
    expect(pm.countWithConfig('abcd1234', 'paper')).toBe(1);
  });

  it('config-hash verandert bij een andere instelling, niet bij slaapstand-optie', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    b.general.preventSleep = !a.general.preventSleep;
    expect(configHash(a)).toBe(configHash(b));
    b.exits.stopLoss.pct = 16;
    expect(configHash(a)).not.toBe(configHash(b));
  });

  it('elke instellingenversie wordt bewaard', () => {
    const db = openDb(':memory:');
    const store = new SettingsStore(db);
    const h1 = store.hash();
    store.update({ exits: { stopLoss: { pct: 12 } } });
    expect(store.versions().map((v) => v.hash)).toEqual(expect.arrayContaining([h1, store.hash()]));
  });
});

describe('circuit breaker voor prijsfeeds', () => {
  it('pas "uitgevallen" na meerdere fouten én 15 s zonder succes; herstelt bij succes', () => {
    const h = new Health();
    const t0 = 1_000_000;
    h.ok('curve', t0);
    h.fail('curve', 'fetch failed', t0 + 1000);
    h.fail('curve', 'fetch failed', t0 + 2000);
    h.fail('curve', 'fetch failed', t0 + 3000);
    expect(h.isDown('curve')).toBe(false); // nog geen 15 s
    h.fail('curve', 'getaddrinfo ENOTFOUND', t0 + 16_000);
    expect(h.downFeeds()).toEqual(['curve']);
    h.ok('curve', t0 + 20_000);
    expect(h.downFeeds()).toEqual([]);
  });

  it('logt herhaalde fouten max. 1× per interval', () => {
    const t = 5_000_000;
    expect(shouldLog('test-x', 60_000, t).ok).toBe(true);
    expect(shouldLog('test-x', 60_000, t + 4000).ok).toBe(false);
    expect(shouldLog('test-x', 60_000, t + 8000).ok).toBe(false);
    const again = shouldLog('test-x', 60_000, t + 61_000);
    expect(again).toEqual({ ok: true, suppressed: 2 });
  });
});

describe('paper-simulatie', () => {
  const curve0 = {
    virtualTokenReserves: 1_000_000_000_000_000n,
    virtualSolReserves: 30_000_000_000n,
    realTokenReserves: 720_000_000_000_000n,
    realSolReserves: 5_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
    mayhem: false,
  };
  // Tijdens de vertraging stijgt de prijs ~10% (iemand koopt vóór ons)
  const curve1 = { ...curve0, virtualSolReserves: 33_000_000_000n, virtualTokenReserves: 909_090_909_090_909n };

  it('fill gebruikt de curve ná de vertraging en rekent landingskosten', async () => {
    let calls = 0;
    const src = { lastPrice: () => null, freshCurve: async () => (calls++ === 0 ? curve0 : curve1) };
    const ex = new PaperExecutor(src, () => ({ latencyMs: 20, landingFeeSol: 0.001 }));
    const f = await ex.buy({ mint: 'M', solAmount: 0.05, slippagePct: 15, priorityFeeSol: 0.0005 });
    expect(f.tokenAmountRaw).toBe(curveBuyQuote(curve1, 50_000_000n));
    expect(f.solAmount).toBeCloseTo(0.05 + 0.0005 + 0.000005 + 0.001, 9);
    // Marktprijs = moment van besluiten, dus de vertraging is zichtbaar als slechtere instap
    const entry = f.solAmount / (Number(f.tokenAmountRaw) / 1e6);
    expect(entry / f.marketPriceSol!).toBeGreaterThan(1.1);
  });
});

describe('slaapstand-detectie', () => {
  it('meldt een gat in de hartslag van meer dan 30 s', () => {
    const h = new Health();
    h.lastBeatAt = 1_000_000;
    h.beat(2, 1_005_000);
    expect(h.lastStallMs).toBe(0);
    h.beat(2, 1_005_000 + 5 * 60_000);
    expect(h.lastStallMs).toBe(5 * 60_000);
  });
});

describe('reset logs', () => {
  it('verwijdert oude logbestanden, maakt het huidige leeg en laat andere bestanden staan', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { resetLogs, logFile, logger } = await import('../src/logger.js');
    const dir = path.dirname(logFile);
    const old = path.join(dir, 'solbot_2000-01-01_00-00-00.log');
    const other = path.join(dir, 'notities.txt');
    fs.writeFileSync(old, 'oud');
    fs.writeFileSync(other, 'blijft');
    fs.appendFileSync(logFile, 'regel\n');
    logger.flush();
    const r = resetLogs();
    expect(r.failed).toEqual([]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.statSync(logFile).size).toBe(0);
    fs.unlinkSync(other);
  });
});
