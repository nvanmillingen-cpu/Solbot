import { Connection, PublicKey } from '@solana/web3.js';
import { SOL_MINT } from '../config.js';
import { logger } from '../logger.js';
import { bondingCurvePda, curveBuyQuote, curveSellQuote, type CurveState } from '../market/bondingCurve.js';
import { jupQuote } from '../market/jupiter.js';
import type { Settings } from '../settings.js';
import type { TokenMetrics } from './metrics.js';

export interface SafetyResult {
  ok: boolean;
  reasons: string[];
  /** Permanent afkeuren (bijv. freeze authority) i.p.v. tijdelijke cooldown. */
  permanent: boolean;
  roundTripLossPct?: number;
  /** % van de supply bij de maker. */
  creatorPct?: number;
  /** % van de supply in top-10 wallets; null = niet beschikbaar via deze RPC. */
  top10Pct?: number | null;
}

/** Token-2022 extensies waarmee de maker transfers kan blokkeren of tokens kan afpakken. */
const DANGEROUS_EXTENSIONS = ['permanentDelegate', 'nonTransferable', 'pausableConfig', 'defaultAccountState'];

interface ParsedMint {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: string;
  extensions?: { extension: string; state?: Record<string, unknown> }[];
}

export interface MintInfo {
  parsed: ParsedMint;
  /** SPL Token of Token-2022 programma. */
  tokenProgram: PublicKey;
}

export async function fetchMint(conn: Connection, mint: string): Promise<MintInfo | null> {
  const info = await conn.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
  const data = info.value?.data;
  if (!info.value || !data || !('parsed' in data)) return null;
  return { parsed: data.parsed.info as ParsedMint, tokenProgram: info.value.owner };
}

const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

/**
 * % van de totale supply dat de maker nu nog bezit. Leest direct het associated token
 * account van de maker (1 goedkope call, werkt op de publieke RPC). Tokens die de maker
 * naar andere wallets heeft verplaatst worden niet meegeteld.
 */
export async function creatorSharePct(conn: Connection, mint: string, creator: string, mi: MintInfo): Promise<number> {
  const ata = associatedTokenAddress(new PublicKey(creator), new PublicKey(mint), mi.tokenProgram);
  const acc = await conn.getAccountInfo(ata, 'confirmed');
  // Token account layout (SPL en Token-2022): mint(32) owner(32) amount(u64)
  const raw = acc && acc.data.length >= 72 ? Buffer.from(acc.data).readBigUInt64LE(64) : 0n;
  const supply = BigInt(mi.parsed.supply);
  return supply > 0n ? (Number(raw) / Number(supply)) * 100 : 0;
}

let lastTop10Warn = 0;
/** Tot wanneer de top-10-check overgeslagen wordt na een weigering door de RPC. */
let top10UnavailableUntil = 0;
let noRetryConn: Connection | undefined;

/**
 * % van de supply in de 10 grootste wallets, zonder de bonding curve (of bij graduated
 * tokens het grootste account = de pool). null als de RPC deze call weigert
 * (de publieke Solana-RPC staat getTokenLargestAccounts niet toe).
 */
export async function top10SharePct(conn: Connection, mint: string, m: MintInfo, graduated: boolean): Promise<number | null> {
  if (Date.now() < top10UnavailableUntil) return null;
  // Eigen verbinding zonder automatische 429-retries (die kosten anders tientallen seconden)
  if (!noRetryConn || noRetryConn.rpcEndpoint !== conn.rpcEndpoint) {
    noRetryConn = new Connection(conn.rpcEndpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  }
  let accounts: { address: PublicKey; amount: string }[];
  try {
    accounts = (await noRetryConn.getTokenLargestAccounts(new PublicKey(mint), 'confirmed')).value;
  } catch (e) {
    top10UnavailableUntil = Date.now() + 10 * 60_000;
    if (Date.now() - lastTop10Warn > 10 * 60_000) {
      lastTop10Warn = Date.now();
      logger.warn({ err: String(e).slice(0, 120) }, 'top-10-holdercheck overgeslagen: RPC weigert getTokenLargestAccounts (gebruik een gratis Helius/QuickNode-RPC)');
    }
    return null;
  }
  const sorted = accounts.filter((a) => BigInt(a.amount) > 0n).sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  let holders: typeof sorted;
  if (!graduated) {
    const curveAta = associatedTokenAddress(bondingCurvePda(mint), new PublicKey(mint), m.tokenProgram).toBase58();
    holders = sorted.filter((a) => a.address.toBase58() !== curveAta);
  } else {
    holders = sorted.slice(1);
  }
  const top = holders.slice(0, 10).reduce((s, a) => s + BigInt(a.amount), 0n);
  const supply = BigInt(m.parsed.supply);
  return supply > 0n ? (Number(top) / Number(supply)) * 100 : null;
}

export function checkMintAuthorities(mi: MintInfo): { ok: boolean; reasons: string[] } {
  const m = mi.parsed;
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
  creator?: string,
): Promise<SafetyResult> {
  const reasons: string[] = [];
  const safety = s.safety;

  if (safety.minLiquidityUsd.enabled && m.graduated) {
    if (m.liquidityUsd === null || m.liquidityUsd < safety.minLiquidityUsd.usd) {
      reasons.push(`liquiditeit te laag (${m.liquidityUsd === null ? 'onbekend' : '$' + Math.round(m.liquidityUsd)})`);
      return { ok: false, reasons, permanent: false };
    }
  }

  let mi: MintInfo | null;
  try {
    mi = await fetchMint(conn, m.mint);
  } catch (e) {
    return { ok: false, reasons: [`mint ophalen mislukt: ${String(e)}`], permanent: false };
  }
  if (!mi) return { ok: false, reasons: ['mint-account niet gevonden'], permanent: false };

  if (safety.requireRevokedAuthorities) {
    const a = checkMintAuthorities(mi);
    if (!a.ok) return { ok: false, reasons: a.reasons, permanent: true };
  }

  // Concentratie: dev-bezit en top-10 holders (beschermt tegen dumps)
  let creatorPct: number | undefined;
  let top10Pct: number | null | undefined;
  if (safety.maxCreatorPct.enabled && creator) {
    try {
      creatorPct = await creatorSharePct(conn, m.mint, creator, mi);
      if (creatorPct > safety.maxCreatorPct.pct) {
        return { ok: false, reasons: [`maker bezit ${creatorPct.toFixed(1)}% > ${safety.maxCreatorPct.pct}%`], permanent: false, creatorPct };
      }
    } catch (e) {
      return { ok: false, reasons: [`dev-bezit niet op te halen: ${String(e).slice(0, 100)}`], permanent: false };
    }
  }
  if (safety.maxTop10Pct.enabled) {
    top10Pct = await top10SharePct(conn, m.mint, mi, m.graduated);
    if (top10Pct !== null && top10Pct > safety.maxTop10Pct.pct) {
      return { ok: false, reasons: [`top-10 holders bezitten ${top10Pct.toFixed(1)}% > ${safety.maxTop10Pct.pct}%`], permanent: false, creatorPct, top10Pct };
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

  return { ok: reasons.length === 0, reasons, permanent: false, roundTripLossPct, creatorPct, top10Pct };
}
