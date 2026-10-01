import { type Connection, VersionedTransaction } from '@solana/web3.js';
import { logger } from '../logger.js';
import type { Wallet } from '../wallet.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TxError extends Error {
  constructor(message: string, public signature?: string) {
    super(signature ? `${message} (${signature})` : message);
  }
}

export interface TxOutcome {
  signature: string;
  /** Verandering in SOL-balans van de wallet (negatief bij kopen), incl. fees. */
  solDelta: number;
  /** Verandering in ruwe tokenbalans van `mint`. */
  tokenDeltaRaw: bigint;
  decimals: number;
}

/**
 * Tekent, verstuurt en bevestigt een transactie. Verstuurt de transactie elke 2 s
 * opnieuw tot hij bevestigd is of de timeout verloopt. Leest daarna de werkelijke
 * SOL- en tokenverandering uit de transactie.
 */
export async function signSendConfirm(conn: Connection, wallet: Wallet, txBytes: Uint8Array, mint: string, timeoutMs = 60_000): Promise<TxOutcome> {
  const tx = VersionedTransaction.deserialize(txBytes);
  wallet.sign(tx);
  const raw = tx.serialize();
  const signature = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0, preflightCommitment: 'processed' });
  logger.info({ signature }, 'transactie verstuurd');

  const start = Date.now();
  let confirmed = false;
  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    const st = (await conn.getSignatureStatuses([signature])).value[0];
    if (st?.err) throw new TxError(`transactie mislukt on-chain: ${JSON.stringify(st.err)}`, signature);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      confirmed = true;
      break;
    }
    // Blockhash verlopen? Dan heeft opnieuw versturen geen zin meer.
    const valid = await conn.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'processed' }).catch(() => ({ value: true }));
    if (!valid.value) break;
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
  }
  if (!confirmed) throw new TxError(`transactie niet bevestigd binnen ${timeoutMs / 1000}s`, signature);

  return parseOutcome(conn, signature, wallet.publicKey.toBase58(), mint);
}

/** Leest de werkelijke SOL- en tokenverandering van `owner` uit een bevestigde transactie. */
export async function parseOutcome(conn: Connection, signature: string, owner: string, mint: string, tries = 10): Promise<TxOutcome> {
  for (let i = 0; i < tries; i++) {
    const parsed = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (parsed?.meta) {
      const meta = parsed.meta;
      if (meta.err) throw new TxError(`transactie mislukt: ${JSON.stringify(meta.err)}`, signature);
      const solDelta = (meta.postBalances[0] - meta.preBalances[0]) / 1e9;
      const sum = (arr: typeof meta.postTokenBalances) =>
        (arr ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
      const decimals = (meta.postTokenBalances ?? []).find((b) => b.mint === mint)?.uiTokenAmount.decimals ?? 6;
      return { signature, solDelta, tokenDeltaRaw: sum(meta.postTokenBalances) - sum(meta.preTokenBalances), decimals };
    }
    await sleep(1500);
  }
  throw new TxError('transactie bevestigd maar details niet op te halen', signature);
}
