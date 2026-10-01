import { Keypair, PublicKey, type Connection, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';
import { logger } from './logger.js';

export interface Wallet {
  publicKey: PublicKey;
  sign(tx: VersionedTransaction): void;
}

export function loadWallet(): Wallet | null {
  const raw = config.privateKey;
  if (!raw) return null;
  try {
    const bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw) as number[]) : bs58.decode(raw);
    const kp = Keypair.fromSecretKey(bytes);
    return {
      publicKey: kp.publicKey,
      sign: (tx) => tx.sign([kp]),
    };
  } catch (e) {
    logger.error({ err: String(e) }, 'PRIVATE_KEY ongeldig (verwacht base58 of JSON-array); alleen paper mode beschikbaar');
    return null;
  }
}

export async function solBalance(conn: Connection, owner: PublicKey): Promise<number> {
  return (await conn.getBalance(owner, 'confirmed')) / 1e9;
}

/** Ruwe tokenbalans (som over alle token accounts van deze mint, SPL én Token-2022). */
export async function tokenBalance(conn: Connection, owner: PublicKey, mint: string): Promise<{ raw: bigint; decimals: number }> {
  const res = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, 'confirmed');
  let raw = 0n;
  let decimals = 6;
  for (const a of res.value) {
    const info = (a.account.data as { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } }).parsed.info;
    raw += BigInt(info.tokenAmount.amount);
    decimals = info.tokenAmount.decimals;
  }
  return { raw, decimals };
}
