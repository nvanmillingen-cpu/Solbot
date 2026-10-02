import { describe, expect, it, vi } from 'vitest';

const jup = { tokensPerSol: 0, solPerToken: 0, fail: false };
vi.mock('../src/market/jupiter.js', () => ({
  jupQuote: vi.fn(async (input: string, _o: string, amount: bigint) => {
    if (jup.fail) throw new Error('geen route');
    if (input === 'So11111111111111111111111111111111111111112') return { outAmount: String(Math.floor((Number(amount) / 1e9) * jup.tokensPerSol * 1e6)) };
    return { outAmount: String(Math.floor((Number(amount) / 1e6) * jup.solPerToken * 1e9)) };
  }),
}));

const { PaperExecutor } = await import('../src/executor/paper.js');
const { curveBuyQuote, curveSellQuote, curvePriceSol } = await import('../src/market/bondingCurve.js');
const { openDb } = await import('../src/db.js');
const { PositionManager } = await import('../src/core/positions.js');
const { defaultSettings } = await import('../src/settings.js');

const curve = {
  virtualTokenReserves: 1_000_000_000_000_000n,
  virtualSolReserves: 30_000_000_000n,
  realTokenReserves: 720_000_000_000_000n,
  realSolReserves: 5_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
  mayhem: false,
};
const src = { lastPrice: () => 3e-8, freshCurve: async () => curve };
const req = { mint: 'M', solAmount: 0.05, slippagePct: 15, priorityFeeSol: 0.0005 };

describe('PaperExecutor', () => {
  it('buy: geen koop als Jupiter sterk afwijkt (BANDS: quote 8,7x te gunstig)', async () => {
    jup.fail = false;
    jup.tokensPerSol = (1 / 3e-8) * 8.7; // Jupiter belooft 8,7x te veel tokens
    await expect(new PaperExecutor(src).buy({ ...req, maxQuoteDeviationPct: 10 })).rejects.toThrow(/prijsbronnen lopen uiteen/);
  });

  it('buy: fill = curve, ook als Jupiter iets ongunstiger is (198kg: quote 9,9% slechter)', async () => {
    const curveTokens = curveBuyQuote(curve, 50_000_000n);
    jup.tokensPerSol = (Number(curveTokens) / 1e6 / 0.05) * 0.91;
    const fill = await new PaperExecutor(src).buy({ ...req, maxQuoteDeviationPct: 10 });
    expect(fill.tokenAmountRaw).toBe(curveTokens);
    expect(fill.executor).toBe('paper/curve');
    expect(fill.marketPriceSol).toBeCloseTo(curvePriceSol(curve), 15);
    // Instapprijs = curveprijs + fees/impact (~2,4%), niet ~10% erboven
    const entry = fill.solAmount / (Number(fill.tokenAmountRaw) / 1e6);
    expect(entry / curvePriceSol(curve)).toBeGreaterThan(1);
    expect(entry / curvePriceSol(curve)).toBeLessThan(1.03);
  });

  it('sell: neemt de laagste opbrengst', async () => {
    jup.solPerToken = 3e-8 * 2; // Jupiter belooft 2x te veel SOL
    const tokens = 1_000_000_000_000n;
    const fill = await new PaperExecutor(src).sell({ ...req, tokenAmountRaw: tokens, decimals: 6 });
    expect(fill.solAmount).toBeCloseTo(Number(curveSellQuote(curve, tokens)) / 1e9 - 0.0005 - 0.000005, 9);
    expect(fill.executor).toBe('paper/curve');
  });

  it('valt terug op de curve als Jupiter geen route heeft', async () => {
    jup.fail = true;
    const fill = await new PaperExecutor(src).buy(req);
    expect(fill.executor).toBe('paper/curve');
    jup.fail = false;
  });

  it('gegradueerd token (geen curve): alleen Jupiter', async () => {
    jup.tokensPerSol = 1 / 3e-8;
    const fill = await new PaperExecutor({ lastPrice: () => 3e-8, freshCurve: async () => undefined }).buy(req);
    expect(fill.executor).toBe('paper/jupiter');
  });
});

describe('PositionManager: exit-trigger en slippage worden vastgelegd (SINS-scenario)', () => {
  it('slaat de triggerprijs op naast de werkelijke verkoopprijs', async () => {
    const db = openDb(':memory:');
    const tracker = { tokens: new Map(), pinned: new Set<string>(), ensure: () => ({}) } as never;
    const sellFill = { solAmount: 0.0157, tokenAmountRaw: 1_700_000_000_000n, decimals: 6, executor: 'paper/curve', marketPriceSol: 9.5e-9 };
    const exec = { name: 'paper', buy: vi.fn(), sell: vi.fn(async () => sellFill) };
    const pm = new PositionManager(db, {} as never, tracker, defaultSettings, () => exec);
    const pos = pm.record({
      mint: 'SINS',
      symbol: 'SINS',
      name: 'SINS',
      mode: 'paper',
      graduated: false,
      fill: { solAmount: 0.0505, tokenAmountRaw: 1_700_000_000_000n, decimals: 6, executor: 'paper/curve', marketPriceSol: 2.9e-8 },
    });
    expect(pos.entry_market_price_sol).toBe(2.9e-8);
    const trigger = pos.entry_price_sol * 0.82; // trail bij -18%
    expect(await pm.sell(pos.id, 'TRAIL', trigger)).toBe(true);
    const closed = pm.get(pos.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.exit_trigger_price_sol).toBeCloseTo(trigger, 15);
    // Werkelijke verkoop lag ver onder de trigger → zichtbaar als slippage
    const slip = (closed.exit_price_sol! / closed.exit_trigger_price_sol! - 1) * 100;
    expect(slip).toBeLessThan(-50);
    expect(closed.pnl_pct).toBeCloseTo((0.0157 / 0.0505 - 1) * 100, 6);
  });

  it('bestaande database (oud schema) krijgt de nieuwe kolommen via migratie', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solbot-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE positions (id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, symbol TEXT, name TEXT, mode TEXT NOT NULL,
      status TEXT NOT NULL, executor TEXT, entry_sol REAL NOT NULL, token_amount_raw TEXT NOT NULL, decimals INTEGER NOT NULL,
      entry_price_sol REAL NOT NULL, opened_at INTEGER NOT NULL, peak_price_sol REAL NOT NULL, last_price_sol REAL, last_price_at INTEGER,
      pending_exit TEXT, sell_attempts INTEGER NOT NULL DEFAULT 0, next_sell_at INTEGER, last_error TEXT, exit_sol REAL, exit_price_sol REAL,
      closed_at INTEGER, exit_reason TEXT, pnl_sol REAL, pnl_pct REAL, buy_sig TEXT, sell_sig TEXT, graduated INTEGER NOT NULL DEFAULT 0)`);
    old.prepare("INSERT INTO positions (mint, mode, status, entry_sol, token_amount_raw, decimals, entry_price_sol, opened_at, peak_price_sol, closed_at, pnl_sol, pnl_pct) VALUES ('X','paper','closed',0.05,'1',6,1,1,1,2,0.01,20)").run();
    old.close();
    const db = openDb(file);
    const cols = (db.prepare('PRAGMA table_info(positions)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('entry_market_price_sol');
    expect(cols).toContain('exit_trigger_price_sol');
    expect((db.prepare('SELECT COUNT(*) AS n FROM positions').get() as { n: number }).n).toBe(1);
  });
});
