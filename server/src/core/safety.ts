import { Connection, PublicKey } from '@solana/web3.js';
import { SOL_MINT } from '../config.js';
import { logger, shouldLog } from '../logger.js';
import { bondingCurvePda, curveBuyQuote, curvePriceSol, curveSellQuote, fetchCurves, type CurveState } from '../market/bondingCurve.js';
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
  /** Aantal holders met saldo (zonder bonding curve/pool). Uit max. 20 grootste accounts, dus een ondergrens bij ≥ 19. */
  holders?: number | null;
  /** Verse on-chain curveprijs uit stap 1 van de check, en het moment waarop die gelezen werd. */
  checkPriceSol?: number | null;
  checkAt?: number;
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
let noRetryConn: Connection | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Of de RPC de top-10-holderdata levert (bijgewerkt bij elke poging en bij de opstarttest). */
export const top10Status = { ok: null as boolean | null, lastError: '', checkedAt: 0 };

function noRetry(conn: Connection): Connection {
  // Eigen verbinding zonder automatische 429-retries van web3.js (die kosten tientallen seconden)
  if (!(conn instanceof Connection)) return conn; // test-dubbel
  if (!noRetryConn || noRetryConn.rpcEndpoint !== conn.rpcEndpoint) {
    noRetryConn = new Connection(conn.rpcEndpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  }
  return noRetryConn;
}

/** getTokenLargestAccounts met maximaal 3 pogingen (400 ms, 1,2 s backoff). */
export async function largestAccounts(conn: Connection, mint: string, attempts = 3): Promise<{ address: PublicKey; amount: string }[] | null> {
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(i === 1 ? 400 : 1200);
    try {
      const res = (await noRetry(conn).getTokenLargestAccounts(new PublicKey(mint), 'confirmed')).value;
      Object.assign(top10Status, { ok: true, lastError: '', checkedAt: Date.now() });
      return res;
    } catch (e) {
      lastErr = String(e instanceof Error ? e.message : e).slice(0, 160);
    }
  }
  Object.assign(top10Status, { ok: false, lastError: lastErr, checkedAt: Date.now() });
  if (Date.now() - lastTop10Warn > 5 * 60_000) {
    lastTop10Warn = Date.now();
    logger.warn({ err: lastErr }, 'top-10-holderdata niet op te halen (RPC weigert getTokenLargestAccounts; gebruik een eigen Helius/QuickNode-RPC)');
  }
  return null;
}

/**
 * Fout die betekent dat de RPC de methode wél ondersteunt, maar het token te veel holders heeft
 * (Helius: "Too many accounts requested"). Voor nieuwe pump.fun-tokens speelt dat niet.
 */
export function isTooManyAccountsError(msg: string): boolean {
  return /too many accounts/i.test(msg);
}

/**
 * Opstarttest: ondersteunt de RPC getTokenLargestAccounts? Test op de USDC-mint. Een
 * "too many accounts"-fout (USDC heeft miljoenen holders) telt als ondersteund.
 */
export async function probeTop10Support(conn: Connection): Promise<boolean> {
  let lastErr = '';
  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(1000);
    try {
      await noRetry(conn).getTokenLargestAccounts(new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'confirmed');
      lastErr = '';
      break;
    } catch (e) {
      lastErr = String(e instanceof Error ? e.message : e).slice(0, 160);
      if (isTooManyAccountsError(lastErr)) {
        lastErr = '';
        break;
      }
    }
  }
  const ok = lastErr === '';
  Object.assign(top10Status, { ok, lastError: lastErr, checkedAt: Date.now() });
  if (ok) logger.info('RPC ondersteunt de top-10-holdercheck');
  else logger.warn({ err: lastErr }, 'RPC ondersteunt de top-10-holdercheck NIET (gebruik een eigen Helius/QuickNode-RPC)');
  return ok;
}

/** Berekent het top-10-aandeel uit de grootste accounts, zonder de bonding curve (of bij graduated de pool). */
export function top10FromAccounts(
  accounts: { address: PublicKey | string; amount: string }[],
  supplyRaw: bigint,
  excludeAddress: string | null,
): number | null {
  const sorted = accounts
    .map((a) => ({ address: typeof a.address === 'string' ? a.address : a.address.toBase58(), amount: BigInt(a.amount) }))
    .filter((a) => a.amount > 0n)
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const holders = excludeAddress ? sorted.filter((a) => a.address !== excludeAddress) : sorted.slice(1);
  const top = holders.slice(0, 10).reduce((s, a) => s + a.amount, 0n);
  return supplyRaw > 0n ? (Number(top) / Number(supplyRaw)) * 100 : null;
}

/**
 * % van de supply in de 10 grootste wallets, zonder de bonding curve (of bij graduated
 * tokens het grootste account = de pool). null als de RPC de data niet levert.
 */
export async function top10SharePct(conn: Connection, mint: string, m: MintInfo, graduated: boolean): Promise<number | null> {
  return (await top10Details(conn, mint, m, graduated)).pct;
}

/** Top-10-aandeel plus het aantal holders uit dezelfde RPC-call (geen extra kosten). */
export async function top10Details(conn: Connection, mint: string, m: MintInfo, graduated: boolean): Promise<{ pct: number | null; holders: number | null }> {
  const accounts = await largestAccounts(conn, mint);
  if (!accounts) return { pct: null, holders: null };
  const exclude = graduated ? null : associatedTokenAddress(bondingCurvePda(mint), new PublicKey(mint), m.tokenProgram).toBase58();
  const nonZero = accounts.filter((a) => BigInt(a.amount) > 0n);
  const holders = exclude ? nonZero.filter((a) => (typeof a.address === 'string' ? a.address : a.address.toBase58()) !== exclude).length : Math.max(0, nonZero.length - 1);
  return { pct: top10FromAccounts(accounts, BigInt(m.parsed.supply), exclude), holders };
}

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** mint → token-programma (SPL Token of Token-2022); verandert nooit. */
const programCache = new Map<string, PublicKey>();

export interface HolderCount {
  count: number;
  /** false = ondergrens (fallback via getTokenLargestAccounts, max. 20 accounts). */
  exact: boolean;
}

/** Telt unieke eigenaren met saldo > 0, zonder de bonding curve (of bij graduated het grootste account = de pool). */
export function holdersFromAccounts(accounts: { owner: string; amount: bigint }[], excludeOwner: string | null): number {
  const withBalance = accounts.filter((a) => a.amount > 0n);
  let rest = excludeOwner ? withBalance.filter((a) => a.owner !== excludeOwner) : withBalance;
  if (!excludeOwner && rest.length) {
    const biggest = rest.reduce((m, a) => (a.amount > m.amount ? a : m));
    rest = rest.filter((a) => a !== biggest);
  }
  return new Set(rest.map((a) => a.owner)).size;
}

/**
 * Exact aantal holders via getProgramAccounts op het token-programma, gefilterd op de mint
 * (alleen eigenaar + saldo worden opgehaald, ~80 ms op Helius). getTokenLargestAccounts geeft
 * maximaal 20 accounts, waardoor een minimum van 20+ holders nooit gehaald kon worden.
 * Fallback als de RPC getProgramAccounts weigert: de grootste 20 accounts (ondergrens).
 */
export async function countHolders(conn: Connection, mint: string, graduated: boolean, tokenProgram?: PublicKey): Promise<HolderCount | null> {
  const mintKey = new PublicKey(mint);
  const excludeOwner = graduated ? null : bondingCurvePda(mint).toBase58();
  try {
    let program = tokenProgram ?? programCache.get(mint);
    if (!program) {
      const info = await conn.getAccountInfo(mintKey, 'confirmed');
      if (!info) return null;
      program = info.owner;
    }
    programCache.set(mint, program);
    const filters: ({ memcmp: { offset: number; bytes: string } } | { dataSize: number })[] = [{ memcmp: { offset: 0, bytes: mint } }];
    // SPL Token-accounts zijn altijd 165 bytes; Token-2022-accounts kunnen extensies hebben
    if (program.toBase58() === SPL_TOKEN_PROGRAM) filters.push({ dataSize: 165 });
    const accs = await noRetry(conn).getProgramAccounts(program, { commitment: 'confirmed', dataSlice: { offset: 32, length: 40 }, filters });
    const rows = accs.map((a) => {
      const d = Buffer.from(a.account.data);
      return { owner: new PublicKey(d.subarray(0, 32)).toBase58(), amount: d.readBigUInt64LE(32) };
    });
    return { count: holdersFromAccounts(rows, excludeOwner), exact: true };
  } catch (e) {
    const l = shouldLog('holders-gpa', 5 * 60_000);
    if (l.ok) logger.warn({ err: String(e).slice(0, 160), overgeslagen: l.suppressed }, 'exact aantal holders niet op te halen (getProgramAccounts); terugval op max. 20 grootste accounts');
  }
  const largest = await largestAccounts(conn, mint, 1);
  if (!largest) return null;
  const program = tokenProgram ?? programCache.get(mint);
  const curveAta = !graduated && program ? associatedTokenAddress(bondingCurvePda(mint), mintKey, program).toBase58() : null;
  const nonZero = largest.filter((a) => BigInt(a.amount) > 0n);
  const count = curveAta ? nonZero.filter((a) => (typeof a.address === 'string' ? a.address : a.address.toBase58()) !== curveAta).length : Math.max(0, nonZero.length - 1);
  return { count, exact: nonZero.length < 20 };
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
export async function roundTripLoss(
  mint: string,
  solAmount: number,
  buySlippagePct: number,
  curve?: CurveState,
  sellSlippagePct = buySlippagePct,
): Promise<{ lossPct: number; quotePriceSol: number | null }> {
  const lamports = BigInt(Math.round(solAmount * 1e9));
  try {
    const buy = await jupQuote(SOL_MINT, mint, lamports, buySlippagePct);
    const sell = await jupQuote(mint, SOL_MINT, BigInt(buy.outAmount), sellSlippagePct);
    // Effectieve koopprijs volgens de quote (SOL per heel token, 6 decimals)
    const quotePriceSol = solAmount / (Number(buy.outAmount) / 1e6);
    return { lossPct: (1 - Number(sell.outAmount) / Number(lamports)) * 100, quotePriceSol };
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
      return { lossPct: (1 - Number(back) / Number(lamports)) * 100, quotePriceSol: null };
    }
    throw new Error(`verkoop-quote mislukt: ${String(e instanceof Error ? e.message : e)}`);
  }
}

export async function preBuyChecks(
  conn: Connection,
  s: Settings,
  m: TokenMetrics,
  solAmount: number,
  creator?: string,
): Promise<SafetyResult> {
  const reasons: string[] = [];
  const safety = s.safety;

  // 1. Verse on-chain curve: klopt "op bonding curve" nog, en is de prijs niet weggelopen?
  let fresh: CurveState | undefined;
  try {
    fresh = (await fetchCurves(conn, [m.mint])).get(m.mint);
  } catch (e) {
    return { ok: false, reasons: [`curve ophalen mislukt: ${String(e).slice(0, 100)}`], permanent: false };
  }
  const onCurve = Boolean(fresh && !fresh.complete);
  if (s.filters.graduated === 'no' && !onCurve) {
    return { ok: false, reasons: [fresh ? 'bonding curve is voltooid (gemigreerd)' : 'geen pump.fun bonding curve gevonden'], permanent: true };
  }
  if (s.filters.excludeMayhem && fresh?.mayhem) return { ok: false, reasons: ['mayhem mode'], permanent: true };
  const freshPrice = onCurve && fresh ? curvePriceSol(fresh) : null;
  const checkAt = Date.now();
  if (freshPrice && m.priceSol) {
    const move = (freshPrice / m.priceSol - 1) * 100;
    if (Math.abs(move) > safety.maxPriceMoveBeforeBuyPct) {
      return { ok: false, reasons: [`prijs ${move.toFixed(0)}% veranderd sinds evaluatie`], permanent: false };
    }
  }
  creator ??= fresh?.creator;

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
  let holders: number | null | undefined;
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
    ({ pct: top10Pct, holders } = await top10Details(conn, m.mint, mi, !onCurve));
    if (top10Pct === null && safety.maxTop10Pct.requireData) {
      return { ok: false, reasons: ['top-10-holders onbekend (RPC-fout); check is verplicht'], permanent: false, creatorPct, top10Pct, holders };
    }
    if (top10Pct !== null && top10Pct > safety.maxTop10Pct.pct) {
      return { ok: false, reasons: [`top-10 holders bezitten ${top10Pct.toFixed(1)}% > ${safety.maxTop10Pct.pct}%`], permanent: false, creatorPct, top10Pct, holders };
    }
  }

  // Exact aantal holders (voor de tradelog); top-10-call geeft er max. 19
  const hc = await countHolders(conn, m.mint, !onCurve, mi.tokenProgram).catch(() => null);
  if (hc) holders = hc.count;

  let roundTripLossPct: number | undefined;
  if (safety.sellQuoteCheck) {
    try {
      const rt = await roundTripLoss(m.mint, solAmount, s.general.buySlippagePct, onCurve ? fresh : undefined, s.general.sellSlippagePct);
      roundTripLossPct = rt.lossPct;
      // Quote moet passen bij de echte on-chain prijs (anders is de fill onbetrouwbaar)
      if (rt.quotePriceSol && freshPrice) {
        const dev = (rt.quotePriceSol / freshPrice - 1) * 100;
        if (Math.abs(dev) > safety.maxQuoteDeviationPct) reasons.push(`quote wijkt ${dev.toFixed(1)}% af van on-chain prijs`);
      }
      if (roundTripLossPct > safety.maxRoundTripLossPct) {
        reasons.push(`round-trip verlies ${roundTripLossPct.toFixed(1)}% > ${safety.maxRoundTripLossPct}%`);
      }
    } catch (e) {
      reasons.push(String(e instanceof Error ? e.message : e));
    }
  }

  return { ok: reasons.length === 0, reasons, permanent: false, roundTripLossPct, creatorPct, top10Pct, holders, checkPriceSol: freshPrice, checkAt };
}
