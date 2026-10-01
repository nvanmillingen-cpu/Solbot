import { PublicKey, type Connection } from '@solana/web3.js';
import { SOL_MINT } from '../config.js';
import { curveBuyQuote, curveSellQuote, type CurveState } from '../market/bondingCurve.js';
import { jupQuote } from '../market/jupiter.js';
import type { Settings } from '../settings.js';
import type { TokenMetrics } from './metrics.js';

export interface SafetyResult {
  ok: boolean;
  reasons: string[];
  /** Permanent afkeuren (bijv. freeze authority) i.p.v. tijdelijke cooldown. */
  permanent: boolean;
  roundTripLossPct?: number;
}

/** Token-2022 extensies waarmee de maker transfers kan blokkeren of tokens kan afpakken. */
const DANGEROUS_EXTENSIONS = ['permanentDelegate', 'nonTransferable', 'pausableConfig', 'defaultAccountState'];

interface ParsedMint {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  extensions?: { extension: string; state?: Record<string, unknown> }[];
}

export async function checkMintAuthorities(conn: Connection, mint: string): Promise<{ ok: boolean; reasons: string[] }> {
  const info = await conn.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
  const data = info.value?.data;
  if (!data || !('parsed' in data)) return { ok: false, reasons: ['mint-account niet gevonden'] };
  const m = data.parsed.info as ParsedMint;
  const reasons: string[] = [];
  if (m.mintAuthority) reasons.push('mint authority niet ingetrokken');
  if (m.freezeAuthority) reasons.push('freeze authority niet ingetrokken (honeypot-risico)');
  for (const ext of m.extensions ?? []) {
    if (DANGEROUS_EXTENSIONS.includes(ext.extension)) reasons.push(`gevaarlijke Token-2022 extensie: ${ext.extension}`);
    if (ext.extension === 'transferHook' && ext.state?.programId) reasons.push('Token-2022 transfer hook actief');
    if (ext.extension === 'transferFeeConfig') {
      const fee = (ext.state?.newerTransferFee as { transferFeeBasisPoints?: number } | undefined)?.transferFeeBasisPoints ?? 0;
      if (fee > 0) reasons.push(`transfer fee van ${fee / 100}%`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Simuleert direct kopen en weer verkopen via Jupiter-quotes. Faalt de verkoop-quote,
 * dan is het token mogelijk een honeypot of is er geen liquiditeit.
 * Voor tokens op de bonding curve wordt bij een Jupiter-fout de curve-wiskunde gebruikt.
 */
export async function roundTripLoss(mint: string, solAmount: number, slippagePct: number, curve?: CurveState): Promise<number> {
  const lamports = BigInt(Math.round(solAmount * 1e9));
  try {
    const buy = await jupQuote(SOL_MINT, mint, lamports, slippagePct);
    const sell = await jupQuote(mint, SOL_MINT, BigInt(buy.outAmount), slippagePct);
    return (1 - Number(sell.outAmount) / Number(lamports)) * 100;
  } catch (e) {
    if (curve && !curve.complete) {
      const tokens = curveBuyQuote(curve, lamports);
      // Na onze koop staat de curve hoger; verkoop rekent met de nieuwe reserves
      const after: CurveState = {
        ...curve,
        virtualSolReserves: curve.virtualSolReserves + lamports,
        virtualTokenReserves: curve.virtualTokenReserves - tokens,
        realSolReserves: curve.realSolReserves + lamports,
        realTokenReserves: curve.realTokenReserves - tokens,
      };
      const back = curveSellQuote(after, tokens);
      return (1 - Number(back) / Number(lamports)) * 100;
    }
    throw new Error(`verkoop-quote mislukt: ${String(e instanceof Error ? e.message : e)}`);
  }
}

export async function preBuyChecks(
  conn: Connection,
  s: Settings,
  m: TokenMetrics,
  solAmount: number,
  curve?: CurveState,
): Promise<SafetyResult> {
  const reasons: string[] = [];
  const safety = s.safety;

  if (safety.minLiquidityUsd.enabled && m.graduated) {
    if (m.liquidityUsd === null || m.liquidityUsd < safety.minLiquidityUsd.usd) {
      reasons.push(`liquiditeit te laag (${m.liquidityUsd === null ? 'onbekend' : '$' + Math.round(m.liquidityUsd)})`);
      return { ok: false, reasons, permanent: false };
    }
  }

  if (safety.requireRevokedAuthorities) {
    try {
      const a = await checkMintAuthorities(conn, m.mint);
      if (!a.ok) return { ok: false, reasons: a.reasons, permanent: true };
    } catch (e) {
      return { ok: false, reasons: [`mint-check mislukt: ${String(e)}`], permanent: false };
    }
  }

  let roundTripLossPct: number | undefined;
  if (safety.sellQuoteCheck) {
    try {
      roundTripLossPct = await roundTripLoss(m.mint, solAmount, s.general.slippagePct, curve);
      if (roundTripLossPct > safety.maxRoundTripLossPct) {
        reasons.push(`round-trip verlies ${roundTripLossPct.toFixed(1)}% > ${safety.maxRoundTripLossPct}%`);
      }
    } catch (e) {
      reasons.push(String(e instanceof Error ? e.message : e));
    }
  }

  return { ok: reasons.length === 0, reasons, permanent: false, roundTripLossPct };
}
