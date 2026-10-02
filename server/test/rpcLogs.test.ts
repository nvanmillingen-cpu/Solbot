import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCreateFromLogs } from '../src/feed/rpcLogs.js';
import { bondingCurvePda } from '../src/market/bondingCurve.js';

// Echte logregels van pump.fun create-transacties (mainnet, vastgelegd)
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-create-logs.json', import.meta.url), 'utf8'));

describe('RPC-fallbackfeed: pump.fun CreateEvent uit echte logs', () => {
  it('decodeert een create met eerste aankoop van de maker', () => {
    const ev = parseCreateFromLogs(fx.withBuy.logs, 1)!;
    expect(ev).not.toBeNull();
    expect(ev.mint).toBe(fx.withBuy.parsed.mint);
    expect(bondingCurvePda(ev.mint).toBase58()).toBe(ev.bondingCurveKey);
    expect(ev.initialBuySol).toBeGreaterThan(0);
    // Lanceringsprijs van een standaard pump.fun-curve: 30 SOL / 1,073 mld tokens
    expect(ev.vSolInBondingCurve / ev.vTokensInBondingCurve).toBeCloseTo(30 / 1_073_000_000, 12);
    expect(ev.source).toBe('rpc');
    expect(ev.pool).toBe('pump');
  });

  it('decodeert een create zonder eerste aankoop', () => {
    const ev = parseCreateFromLogs(fx.noBuy.logs, 1)!;
    expect(ev.mint).toBe(fx.noBuy.parsed.mint);
    expect(ev.initialBuySol).toBe(0);
  });

  it('negeert transacties zonder token-create (bijv. CreateTokenAccount in een swap)', () => {
    expect(parseCreateFromLogs(['Program log: Instruction: CreateTokenAccount', 'Program log: Instruction: Sell'])).toBeNull();
    expect(parseCreateFromLogs(['Program log: Instruction: Buy', 'Program data: AAAA'])).toBeNull();
  });
});
