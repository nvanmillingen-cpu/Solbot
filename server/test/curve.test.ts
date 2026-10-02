import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { curveBuyQuote, curveMarketCapSol, curvePriceSol, curveSellQuote, curveSupply, decodeCurve, type CurveState } from '../src/market/bondingCurve.js';

// Startwaarden van een verse pump.fun curve
const fresh: CurveState = {
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualSolReserves: 30_000_000_000n,
  realTokenReserves: 793_100_000_000_000n,
  realSolReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
  mayhem: false,
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
    expect(decodeCurve(buf)).toMatchObject({ ...fresh, complete: true, mayhem: false });
    expect(decodeCurve(Buffer.alloc(10))).toBeNull();
  });
});

describe('curve-layout: creator en mayhem', () => {
  const creator = new PublicKey('9HsdfT7phLNwTwQvvtXza6ywxodC9dT9MyuKrRLs1d31');
  const build = (mayhemByte: number, len = 151) => {
    const buf = Buffer.alloc(len);
    let o = 8;
    for (const v of [fresh.virtualTokenReserves, fresh.virtualSolReserves, fresh.realTokenReserves, fresh.realSolReserves, fresh.tokenTotalSupply]) {
      buf.writeBigUInt64LE(v, o);
      o += 8;
    }
    creator.toBuffer().copy(buf, 49);
    buf[81] = mayhemByte;
    return buf;
  };

  it('leest creator en mayhem-vlag (offset 49 en 81)', () => {
    const normal = decodeCurve(build(0))!;
    expect(normal.creator).toBe(creator.toBase58());
    expect(normal.mayhem).toBe(false);
    const mayhem = decodeCurve(build(1, 125))!;
    expect(mayhem.mayhem).toBe(true);
  });

  it('mayhem-tokens hebben 2 miljard supply, dus 2x market cap', () => {
    const m = decodeCurve(build(1))!;
    expect(curveSupply(m)).toBe(2_000_000_000);
    expect(curveMarketCapSol(m)).toBeCloseTo(2 * curveMarketCapSol(fresh), 6);
  });
});
