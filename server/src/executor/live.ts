import type { Connection } from '@solana/web3.js';
import { SOL_MINT } from '../config.js';
import { logger } from '../logger.js';
import { jupQuote, jupSwapTx } from '../market/jupiter.js';
import { fetchJson } from '../util/http.js';
import { tokenBalance, type Wallet } from '../wallet.js';
import { parseOutcome, signSendConfirm, TxError, type TxOutcome } from './txSender.js';
import type { BuyRequest, Executor, Fill, SellRequest } from './types.js';

/** Bouwt een swap-transactie; versturen gebeurt centraal in LiveExecutor. */
interface TxBuilder {
  readonly name: string;
  buildBuy(r: BuyRequest, owner: string): Promise<Uint8Array>;
  buildSell(r: SellRequest, owner: string): Promise<Uint8Array>;
}

/** Jupiter (lite) API: routeert zowel graduated tokens als de pump.fun bonding curve. Geen extra fee. */
export class JupiterBuilder implements TxBuilder {
  readonly name = 'jupiter';
  async buildBuy(r: BuyRequest, owner: string) {
    const q = await jupQuote(SOL_MINT, r.mint, BigInt(Math.round(r.solAmount * 1e9)), r.slippagePct);
    return Buffer.from(await jupSwapTx(q, owner, r.priorityFeeSol), 'base64');
  }
  async buildSell(r: SellRequest, owner: string) {
    const q = await jupQuote(r.mint, SOL_MINT, r.tokenAmountRaw, r.slippagePct);
    return Buffer.from(await jupSwapTx(q, owner, r.priorityFeeSol), 'base64');
  }
}

/** PumpPortal local-transaction API: bouwt de tx, wij tekenen lokaal. Let op: PumpPortal rekent 0,5% fee. */
export class PumpPortalBuilder implements TxBuilder {
  readonly name = 'pumpportal';
  private async build(body: Record<string, unknown>) {
    const buf = await fetchJson<ArrayBuffer>('https://pumpportal.fun/api/trade-local', { method: 'POST', body, binary: true, retries: 1 });
    return new Uint8Array(buf);
  }
  buildBuy(r: BuyRequest, owner: string) {
    return this.build({
      publicKey: owner,
      action: 'buy',
      mint: r.mint,
      amount: r.solAmount,
      denominatedInSol: 'true',
      slippage: r.slippagePct,
      priorityFee: r.priorityFeeSol,
      pool: 'auto',
    });
  }
  buildSell(r: SellRequest, owner: string) {
    return this.build({
      publicKey: owner,
      action: 'sell',
      mint: r.mint,
      amount: Number(r.tokenAmountRaw) / 10 ** r.decimals,
      denominatedInSol: 'false',
      slippage: r.slippagePct,
      priorityFee: r.priorityFeeSol,
      pool: 'auto',
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Echte transacties. Probeert de gekozen builder, valt terug op de andere, en
 * herhaalt tot `maxRetries` keer. Vóór elke herhaling wordt de wallet gecontroleerd
 * zodat een transactie die tóch landde niet dubbel wordt uitgevoerd.
 */
export class LiveExecutor implements Executor {
  readonly name = 'live';

  constructor(
    private conn: Connection,
    private wallet: Wallet,
    private builders: () => TxBuilder[],
    private maxRetries: () => number,
  ) {}

  private async attempt(kind: 'buy' | 'sell', r: BuyRequest | SellRequest): Promise<{ out: TxOutcome; via: string }> {
    const owner = this.wallet.publicKey.toBase58();
    let lastErr: unknown;
    for (const b of this.builders()) {
      try {
        const bytes = kind === 'buy' ? await b.buildBuy(r as BuyRequest, owner) : await b.buildSell(r as SellRequest, owner);
        const out = await signSendConfirm(this.conn, this.wallet, bytes, r.mint);
        return { out, via: b.name };
      } catch (e) {
        lastErr = e;
        logger.warn({ executor: b.name, kind, mint: r.mint, err: String(e) }, 'executor mislukt');
      }
    }
    throw lastErr;
  }

  async buy(r: BuyRequest): Promise<Fill> {
    const before = await tokenBalance(this.conn, this.wallet.publicKey, r.mint);
    const retries = this.maxRetries();
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      if (i > 0) {
        await sleep(1500 * i);
        // Is een eerdere poging toch geland?
        const now = await tokenBalance(this.conn, this.wallet.publicKey, r.mint).catch(() => before);
        if (now.raw > before.raw) {
          logger.warn({ mint: r.mint }, 'eerdere koop blijkt toch geland; geen nieuwe poging');
          return { solAmount: r.solAmount + r.priorityFeeSol, tokenAmountRaw: now.raw - before.raw, decimals: now.decimals, executor: 'live/onbekend' };
        }
      }
      try {
        const sentAt = Date.now();
        const { out, via } = await this.attempt('buy', r);
        if (out.tokenDeltaRaw <= 0n) throw new Error(`koop bevestigd maar geen tokens ontvangen (${out.signature})`);
        return { signature: out.signature, solAmount: -out.solDelta, tokenAmountRaw: out.tokenDeltaRaw, decimals: out.decimals, executor: via, sentAt, landedAt: Date.now() };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async sell(r: SellRequest): Promise<Fill> {
    const retries = this.maxRetries();
    let lastErr: unknown;
    const owner = this.wallet.publicKey.toBase58();
    for (let i = 0; i <= retries; i++) {
      // Verkoop nooit meer dan er werkelijk in de wallet zit
      const bal = await tokenBalance(this.conn, this.wallet.publicKey, r.mint);
      if (bal.raw === 0n) {
        if (i === 0) throw new Error('geen tokens in wallet om te verkopen');
        logger.warn({ mint: r.mint }, 'eerdere verkoop blijkt toch geland');
        const sig = lastErr instanceof TxError ? lastErr.signature : undefined;
        const out = sig ? await parseOutcome(this.conn, sig, owner, r.mint, 3).catch(() => null) : null;
        return { signature: sig, solAmount: out?.solDelta ?? 0, tokenAmountRaw: r.tokenAmountRaw, decimals: r.decimals, executor: 'live/onbekend' };
      }
      const amount = bal.raw < r.tokenAmountRaw ? bal.raw : r.tokenAmountRaw;
      // Elke herhaling iets meer slippage (max 50%)
      const slippagePct = Math.min(50, r.slippagePct + i * 5);
      if (i > 0) await sleep(1500 * i);
      try {
        const sentAt = Date.now();
        const { out, via } = await this.attempt('sell', { ...r, tokenAmountRaw: amount, decimals: bal.decimals, slippagePct });
        return { signature: out.signature, solAmount: out.solDelta, tokenAmountRaw: -out.tokenDeltaRaw, decimals: out.decimals, executor: via, sentAt, landedAt: Date.now() };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }
}
