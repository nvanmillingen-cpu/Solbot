import { describe, expect, it } from 'vitest';
import { curveBuyQuote, curveMarketCapSol, curvePriceSol, curveSellQuote, decodeCurve, type CurveState } from '../src/market/bondingCurve.js';

// Startwaarden van een verse pump.fun curve
const fresh: CurveState = {
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualSolReserves: 30_000_000_000n,
  realTokenReserves: 793_100_000_000_000n,
  realSolReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
};

describe('bonding curve', () => {
  it('computes the launch price and market cap', () => {
    expect(curvePriceSol(fresh)).toBeCloseTo(30 / 1_073_000_000, 15);
    expect(curveMarketCapSol(fresh)).toBeCloseTo(27.96, 2);
  });

  it('buy then sell loses roughly twice the fee', () => {
    const lamports = 1_000_000_000n;
    const tokens = curveBuyQuote(fresh, lamports);
    expect(tokens).toBeGreaterThan(0n);
    const after: CurveState = {
      ...fresh,
      virtualSolReserves: fresh.virtualSolReserves + lamports,
      virtualTokenReserves: fresh.virtualTokenReserves - tokens,
      realSolReserves: lamports,
      realTokenReserves: fresh.realTokenReserves - tokens,
    };
    const back = curveSellQuote(after, tokens);
    const lossPct = (1 - Number(back) / Number(lamports)) * 100;
    expect(lossPct).toBeGreaterThan(2);
    expect(lossPct).toBeLessThan(3.5);
  });

  it('returns nothing for a completed curve', () => {
    expect(curveBuyQuote({ ...fresh, complete: true }, 1_000_000n)).toBe(0n);
  });

  it('decodes the on-chain account layout', () => {
    const buf = Buffer.alloc(8 + 5 * 8 + 1 + 32);
    let o = 8;
    for (const v of [fresh.virtualTokenReserves, fresh.virtualSolReserves, fresh.realTokenReserves, fresh.realSolReserves, fresh.tokenTotalSupply]) {
      buf.writeBigUInt64LE(v, o);
      o += 8;
    }
    buf[o] = 1;
    expect(decodeCurve(buf)).toEqual({ ...fresh, complete: true });
    expect(decodeCurve(Buffer.alloc(10))).toBeNull();
  });
});
