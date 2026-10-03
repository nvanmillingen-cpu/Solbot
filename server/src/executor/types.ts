export interface BuyRequest {
  mint: string;
  solAmount: number;
  slippagePct: number;
  priorityFeeSol: number;
  /** Paper: max. afwijking Jupiter-quote vs curve; daarboven wordt de koop afgebroken. */
  maxQuoteDeviationPct?: number;
}

export interface SellRequest {
  mint: string;
  tokenAmountRaw: bigint;
  decimals: number;
  slippagePct: number;
  priorityFeeSol: number;
}

export interface Fill {
  signature?: string;
  /** Buy: totaal uitgegeven SOL (incl. fees). Sell: netto ontvangen SOL. */
  solAmount: number;
  tokenAmountRaw: bigint;
  decimals: number;
  executor: string;
  /** Marktprijs (on-chain curve) op het moment van de fill, voor slippage-analyse. */
  marketPriceSol?: number;
  /** Moment van verzenden (paper: begin van de gesimuleerde transactie). */
  sentAt?: number;
  /** Moment van landen/bevestiging (paper: na de gesimuleerde vertraging). */
  landedAt?: number;
  /** Marktprijs (curve) op het moment van landen. */
  landedMarketPriceSol?: number;
}

/** Uitwisselbare executor-laag: paper, Jupiter of PumpPortal. */
export interface Executor {
  readonly name: string;
  buy(req: BuyRequest): Promise<Fill>;
  sell(req: SellRequest): Promise<Fill>;
}

/** Basis-transactiefee (5000 lamports per handtekening). */
export const BASE_FEE_SOL = 0.000005;
