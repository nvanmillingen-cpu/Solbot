import { z } from 'zod';
import type { Db } from './db.js';

const toggle = <T extends z.ZodRawShape>(shape: T, enabled = false) =>
  z.object({ enabled: z.boolean().default(enabled), ...shape });

const pos = z.number().min(0);

export const settingsSchema = z.object({
  general: z
    .object({
      /** Paper mode: gesimuleerde trades op live prijzen. */
      paperMode: z.boolean().default(true),
      /** Welke executor live transacties bouwt; de andere is fallback. */
      executor: z.enum(['jupiter', 'pumpportal']).default('jupiter'),
      slippagePct: z.number().min(0.1).max(99).default(15),
      priorityFeeSol: pos.max(0.1).default(0.0005),
      maxTxRetries: z.number().int().min(0).max(10).default(2),
    })
    .prefault({}),
  risk: z
    .object({
      solPerTrade: z.number().positive().max(100).default(0.05),
      maxOpenPositions: z.number().int().min(1).max(50).default(3),
      dailyLossLimit: toggle({ sol: z.number().positive().default(0.3) }, true).prefault({}),
      /** SOL die altijd in de wallet moet blijven voor fees. */
      minSolReserve: pos.default(0.02),
    })
    .prefault({}),
  filters: z
    .object({
      /** Minimale prijsstijging in % binnen het venster (of sinds lancering als het token jonger is). */
      priceChange: toggle(
        {
          minPct: z.number().default(25),
          /** Maximale stijging (0 = geen maximum): om te late pumps te vermijden. */
          maxPct: pos.default(0),
          windowMin: z.number().positive().default(10),
        },
        true,
      ).prefault({}),
      volumeTotal: toggle({ minUsd: pos.default(8000) }, true).prefault({}),
      volume10m: toggle({ minUsd: pos.default(4000) }, true).prefault({}),
      marketCap: toggle({ minUsd: pos.default(10000), maxUsd: pos.default(60000) }, true).prefault({}),
      graduated: z.enum(['any', 'yes', 'no']).default('no'),
      /** Sla pump.fun mayhem-mode-tokens over (2B supply, AI-agent handelt mee). */
      excludeMayhem: z.boolean().default(true),
      minAge: toggle({ minutes: pos.default(2) }, true).prefault({}),
      maxAge: toggle({ minutes: pos.default(30) }, true).prefault({}),
      minHolders: toggle({ count: z.number().int().min(0).default(15) }).prefault({}),
    })
    .prefault({}),
  exits: z
    .object({
      stopLoss: toggle({ pct: z.number().positive().max(100).default(20) }, true).prefault({}),
      takeProfit: toggle({ pct: z.number().positive().default(50) }, true).prefault({}),
      maxHold: toggle({ minutes: z.number().positive().default(15) }, true).prefault({}),
      trailingStop: toggle(
        {
          pct: z.number().positive().max(100).default(15),
          /** Trailing stop pas actief zodra de winst (op de piek) dit % heeft bereikt. 0 = direct vanaf aankoop. */
          activatePct: pos.default(20),
        },
        true,
      ).prefault({}),
    })
    .prefault({}),
  safety: z
    .object({
      /** Verkoop-quote moet slagen vóór aankoop. */
      sellQuoteCheck: z.boolean().default(true),
      /** Max. verlies bij direct kopen en weer verkopen (fees + slippage + impact). */
      maxRoundTripLossPct: z.number().min(0).max(100).default(10),
      /** Mint- en freeze-authority moeten ingetrokken zijn. */
      requireRevokedAuthorities: z.boolean().default(true),
      minLiquidityUsd: toggle({ usd: pos.default(5000) }, true).prefault({}),
      /** Max. % van de supply dat de maker (dev) nog bezit: beschermt tegen een dev-dump. */
      maxCreatorPct: toggle({ pct: pos.max(100).default(5) }, true).prefault({}),
      /** Max. % van de supply in de 10 grootste wallets (excl. bonding curve/pool). Vereist een RPC die getTokenLargestAccounts toestaat. */
      maxTop10Pct: toggle(
        {
          pct: pos.max(100).default(35),
          /** Niet kopen als de top-10 niet bepaald kan worden (RPC-fout). Veilig: aan laten. */
          requireData: z.boolean().default(true),
        },
        true,
      ).prefault({}),
      /** Max. afwijking tussen de quote en de actuele on-chain curveprijs (beschermt tegen foute fills). */
      maxQuoteDeviationPct: pos.max(100).default(10),
      /** Max. prijsverandering tussen evaluatie (filters) en aankoop. */
      maxPriceMoveBeforeBuyPct: pos.max(1000).default(25),
    })
    .prefault({}),
  tracker: z
    .object({
      /** Hoe lang een nieuw token gevolgd wordt (minuten). */
      watchWindowMin: z.number().positive().max(24 * 60).default(30),
      /** Pollinterval voor on-chain bonding-curve data (seconden). */
      curvePollSec: z.number().min(1).max(120).default(5),
      /** Pollinterval voor DexScreener (seconden). */
      dexPollSec: z.number().min(5).max(600).default(20),
      /** Pollinterval voor prijzen van open posities (seconden). */
      positionPollSec: z.number().min(1).max(60).default(1),
      maxTrackedTokens: z.number().int().min(10).max(5000).default(800),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

/** Diep samenvoegen zodat een gedeeltelijke update de rest niet wist. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out;
}

type Listener = (s: Settings) => void;

export class SettingsStore {
  private current: Settings;
  private listeners: Listener[] = [];

  constructor(private db: Db) {
    const row = db.prepare('SELECT json FROM settings WHERE id = 1').get() as { json: string } | undefined;
    let loaded: Settings;
    try {
      loaded = settingsSchema.parse(row ? JSON.parse(row.json) : {});
    } catch {
      loaded = defaultSettings();
    }
    this.current = loaded;
    this.persist();
  }

  get(): Settings {
    return this.current;
  }

  /** Valideert en slaat op; gooit een ZodError bij ongeldige waarden. */
  update(patch: unknown): Settings {
    const next = settingsSchema.parse(deepMerge(this.current, patch));
    this.current = next;
    this.persist();
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(l: Listener): void {
    this.listeners.push(l);
  }

  private persist() {
    this.db
      .prepare('INSERT INTO settings (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(JSON.stringify(this.current), Date.now());
  }
}
