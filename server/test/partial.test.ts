import { describe, expect, it, vi } from 'vitest';
import { evaluatePartial, INITIAL_FEE_MARGIN } from '../src/core/exits.js';
import { defaultSettings } from '../src/settings.js';

const exits = () => {
  const e = defaultSettings().exits;
  e.takeInitial = { enabled: true, pct: 100 };
  e.partialTakeProfit = { enabled: true, levels: [{ pct: 50, sellPct: 50 }, { pct: 200, sellPct: 50 }] };
  return e;
};
const base = { entryPriceSol: 1, entrySol: 0.05, remainingTokens: 0.05, done: [] as string[] };

describe('evaluatePartial', () => {
  it('niets onder het eerste niveau', () => {
    expect(evaluatePartial(base, 1.4, exits())).toBeNull();
  });

  it('deel take-profit: bij +50% de helft van de rest', () => {
    expect(evaluatePartial(base, 1.5, exits())).toEqual({ key: 'tp50', kind: 'PTP', fraction: 0.5 });
  });

  it('een niveau vuurt maar één keer; daarna het volgende', () => {
    expect(evaluatePartial({ ...base, done: ['tp50'] }, 1.6, exits())).toBeNull();
    expect(evaluatePartial({ ...base, done: ['tp50', 'init'] }, 3, exits())?.key).toBe('tp200');
  });

  it('inzet eruit: bij +100% zoveel verkopen dat de inleg terug is (≈ helft + feemarge)', () => {
    const r = evaluatePartial({ ...base, done: ['tp50'] }, 2, exits())!;
    expect(r.kind).toBe('INIT');
    expect(r.fraction).toBeCloseTo(0.5 * INITIAL_FEE_MARGIN, 6);
  });

  it('inzet eruit gaat vóór een deel-TP op hetzelfde moment', () => {
    expect(evaluatePartial(base, 2.5, exits())?.key).toBe('init');
  });

  it('uitgeschakeld = nooit', () => {
    const e = exits();
    e.takeInitial.enabled = false;
    e.partialTakeProfit.enabled = false;
    expect(evaluatePartial(base, 10, e)).toBeNull();
  });
});

describe('PositionManager: deelverkopen en eind-P&L', () => {
  it('inzet eruit → deel-TP → eindverkoop: P&L telt alle opbrengsten', async () => {
    const { openDb } = await import('../src/db.js');
    const { PositionManager, remainingRaw } = await import('../src/core/positions.js');
    const db = openDb(':memory:');
    const tracker = { tokens: new Map(), pinned: new Set<string>(), ensure: () => ({}), markGraduated: () => undefined } as never;
    // Paper-achtige executor: verkoopt tegen een vaste prijs per token
    let price = 1e-7;
    const exec = {
      name: 'test',
      buy: vi.fn(),
      sell: vi.fn(async (r: { tokenAmountRaw: bigint; decimals: number }) => ({
        solAmount: (Number(r.tokenAmountRaw) / 1e6) * price,
        tokenAmountRaw: r.tokenAmountRaw,
        decimals: 6,
        executor: 'test',
      })),
    };
    const s = defaultSettings();
    s.exits.takeProfit.enabled = false;
    s.exits.trailingStop.enabled = false;
    s.exits.takeInitial = { enabled: true, pct: 100 };
    s.exits.partialTakeProfit = { enabled: true, levels: [{ pct: 200, sellPct: 50 }] };
    const pm = new PositionManager(db, { removeAccountChangeListener: async () => undefined } as never, tracker, () => s, () => exec);
    // 0,05 SOL voor 500.000 tokens → instap 1e-7
    const pos = pm.record({
      mint: 'M',
      symbol: 'M',
      name: '',
      mode: 'paper',
      graduated: false,
      fill: { solAmount: 0.05, tokenAmountRaw: 500_000_000_000n, decimals: 6, executor: 'test' },
      entry: { ageMin: 4.2, mcapUsd: 25_000, volTotalUsd: 12_000, vol10mUsd: 6_000, priceChangePct: 80, holders: 19, top10Pct: 22.5, creatorPct: 1.2, rtLossPct: 2.6 },
    });
    expect(pos.entry_holders).toBe(19);
    expect(pos.entry_top10_pct).toBe(22.5);
    const tick = (p: number) => (pm as unknown as { handlePrice: (r: unknown, p: number, n: number) => void }).handlePrice(pm.get(pos.id), p, Date.now());
    const settle = () => new Promise((r) => setTimeout(r, 10));

    // +100%: inzet eruit
    price = 2e-7;
    tick(price);
    await settle();
    let r = pm.get(pos.id)!;
    expect(r.status).toBe('open');
    expect(r.partial_done).toBe('init');
    expect(r.realized_sol).toBeCloseTo(0.05 * 1.04, 6); // inleg + feemarge terug
    const afterInit = remainingRaw(r);
    expect(Number(afterInit) / 500_000_000_000).toBeCloseTo(0.48, 2);

    // Zelfde prijs nogmaals: geen tweede deelverkoop
    tick(price);
    await settle();
    expect(exec.sell).toHaveBeenCalledTimes(1);

    // +200%: helft van de rest
    price = 3e-7;
    tick(price);
    await settle();
    r = pm.get(pos.id)!;
    expect(r.partial_done).toBe('init,tp200');
    expect(remainingRaw(r)).toBe(afterInit - afterInit / 2n);

    // Eindverkoop van de rest
    price = 2.5e-7;
    expect(await pm.sell(pos.id, 'MANUAL')).toBe(true);
    r = pm.get(pos.id)!;
    const sells = db.prepare('SELECT kind, sol FROM position_sells WHERE position_id = ? ORDER BY id').all(pos.id) as { kind: string; sol: number }[];
    expect(sells.map((x) => x.kind)).toEqual(['INIT', 'PTP', 'MANUAL']);
    const total = sells.reduce((a, x) => a + x.sol, 0);
    expect(r.exit_sol).toBeCloseTo(total, 9);
    expect(r.pnl_sol).toBeCloseTo(total - 0.05, 9);
    const csv = pm.allForExport()[0];
    expect(csv.deelverkopen).toBe('init,tp200');
    expect(csv.holders).toBe(19);
    expect(csv.mcap_usd).toBe(25_000);
  });
});

describe('inzet eruit telt eerdere deelopbrengsten mee (TripleP)', () => {
  const e = () => {
    const x = defaultSettings().exits;
    x.takeInitial = { enabled: true, pct: 30 };
    return x;
  };
  it('helft al verkocht met 0,029 SOL terug: alleen het tekort verkopen, niet alles', () => {
    // inleg 0,0515; rest 50% van de tokens is bij +30% 0,0335 SOL waard
    const r = evaluatePartial({ entryPriceSol: 1, entrySol: 0.0515, realizedSol: 0.0294, remainingTokens: 0.025755, done: ['tp20'] }, 1.3, e())!;
    const need = 0.0515 * INITIAL_FEE_MARGIN - 0.0294;
    expect(r.fraction).toBeCloseTo(need / (0.025755 * 1.3), 6);
    expect(r.fraction).toBeLessThan(0.8); // vroeger 1 (alles verkocht)
  });

  it('inleg al helemaal terug: niveau afvinken zonder verkoop', () => {
    const r = evaluatePartial({ entryPriceSol: 1, entrySol: 0.05, realizedSol: 0.06, remainingTokens: 0.02, done: [] }, 1.3, e())!;
    expect(r).toEqual({ key: 'init', kind: 'INIT', fraction: 0 });
  });
});
