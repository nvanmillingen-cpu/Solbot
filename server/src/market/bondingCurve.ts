import { PublicKey, type Connection } from '@solana/web3.js';
import { LAMPORTS_PER_SOL, PUMP_PROGRAM_ID, PUMP_TOKEN_DECIMALS, PUMP_TOTAL_SUPPLY } from '../config.js';

export interface CurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

const PROGRAM = new PublicKey(PUMP_PROGRAM_ID);
/** Totale fee op de bonding curve (protocol + creator). Conservatief geschat. */
export const CURVE_FEE_BPS = 125n;

const pdaCache = new Map<string, PublicKey>();

export function bondingCurvePda(mint: string): PublicKey {
  let pda = pdaCache.get(mint);
  if (!pda) {
    pda = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PROGRAM)[0];
    pdaCache.set(mint, pda);
  }
  return pda;
}

/** Layout: 8 bytes discriminator, 5× u64, 1 bool, daarna creator e.d. */
export function decodeCurve(data: Buffer | Uint8Array): CurveState | null {
  const buf = Buffer.from(data);
  if (buf.length < 8 + 5 * 8 + 1) return null;
  let o = 8;
  const u64 = () => {
    const v = buf.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  return {
    virtualTokenReserves: u64(),
    virtualSolReserves: u64(),
    realTokenReserves: u64(),
    realSolReserves: u64(),
    tokenTotalSupply: u64(),
    complete: buf[o] === 1,
  };
}

/** Prijs in SOL per (hele) token. */
export function curvePriceSol(c: Pick<CurveState, 'virtualSolReserves' | 'virtualTokenReserves'>): number {
  if (c.virtualTokenReserves === 0n) return 0;
  return Number(c.virtualSolReserves) / LAMPORTS_PER_SOL / (Number(c.virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS);
}

export function curveMarketCapSol(c: CurveState): number {
  return curvePriceSol(c) * PUMP_TOTAL_SUPPLY;
}

/** Aantal (ruwe) tokens voor `lamportsIn` SOL, na fee. */
export function curveBuyQuote(c: CurveState, lamportsIn: bigint, feeBps = CURVE_FEE_BPS): bigint {
  if (c.complete || lamportsIn <= 0n) return 0n;
  const afterFee = (lamportsIn * 10_000n) / (10_000n + feeBps);
  const out = (afterFee * c.virtualTokenReserves) / (c.virtualSolReserves + afterFee);
  return out > c.realTokenReserves ? c.realTokenReserves : out;
}

/** Aantal lamports voor het verkopen van `tokensIn` (ruw), na fee. */
export function curveSellQuote(c: CurveState, tokensIn: bigint, feeBps = CURVE_FEE_BPS): bigint {
  if (c.complete || tokensIn <= 0n) return 0n;
  const gross = (tokensIn * c.virtualSolReserves) / (c.virtualTokenReserves + tokensIn);
  const capped = gross > c.realSolReserves ? c.realSolReserves : gross;
  return capped - (capped * feeBps) / 10_000n;
}

/** Haalt meerdere curves tegelijk op (max 100 per RPC-call). */
export async function fetchCurves(conn: Connection, mints: string[]): Promise<Map<string, CurveState>> {
  const out = new Map<string, CurveState>();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk.map(bondingCurvePda), 'processed');
    infos.forEach((info, j) => {
      if (!info) return;
      const st = decodeCurve(info.data);
      if (st) out.set(chunk[j], st);
    });
  }
  return out;
}
