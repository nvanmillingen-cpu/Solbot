export type { Settings } from '../../server/src/settings';
export type { OpenPositionView, PositionRow } from '../../server/src/core/positions';
export type { TradeStats, PnlPoint } from '../../server/src/core/stats';
export type { Candidate } from '../../server/src/core/bot';
export type { LogEntry } from '../../server/src/logger';
import type { OpenPositionView } from '../../server/src/core/positions';
import type { TradeStats } from '../../server/src/core/stats';

export interface BotState {
  now: number;
  running: boolean;
  mode: 'paper' | 'live';
  liveTradingEnabled: boolean;
  wallet: { address: string; sol: number | null } | null;
  solUsd: number;
  feed: { connected: boolean; tradesAvailable: boolean; lastMessageAt: number; lastNewTokenAt: number; rpcFallbackActive: boolean };
  top10: { ok: boolean | null; lastError: string; checkedAt: number; required: boolean; enabled: boolean };
  tracker: { tracked: number; newTokens: number; migrations: number; curvePolls: number; dexPolls: number; errors: number };
  blocker: string | null;
  positions: OpenPositionView[];
  stats: TradeStats;
  maxOpenPositions: number;
  lastEvalAt: number;
}
