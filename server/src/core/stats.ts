export interface ClosedTrade {
  closed_at: number;
  pnl_sol: number;
  pnl_pct: number;
}

export interface TradeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgPnlPct: number;
  avgPnlSol: number;
  totalPnlSol: number;
  bestPct: number | null;
  worstPct: number | null;
}

export function computeStats(trades: ClosedTrade[]): TradeStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl_sol > 0).length;
  const total = trades.reduce((s, t) => s + t.pnl_sol, 0);
  const pcts = trades.map((t) => t.pnl_pct);
  return {
    totalTrades: n,
    wins,
    losses: n - wins,
    winRatePct: n ? (wins / n) * 100 : 0,
    avgPnlPct: n ? pcts.reduce((a, b) => a + b, 0) / n : 0,
    avgPnlSol: n ? total / n : 0,
    totalPnlSol: total,
    bestPct: n ? Math.max(...pcts) : null,
    worstPct: n ? Math.min(...pcts) : null,
  };
}

export interface PnlPoint {
  t: number;
  /** Cumulatieve P&L binnen het bereik. */
  cumPnlSol: number;
  pnlSol: number;
}

/** Cumulatieve P&L-lijn vanaf `from` (trades gesorteerd op closed_at). */
export function pnlSeries(trades: ClosedTrade[], from: number, now = Date.now()): PnlPoint[] {
  const sorted = trades.filter((t) => t.closed_at >= from).sort((a, b) => a.closed_at - b.closed_at);
  const start = from > 0 ? from : sorted[0]?.closed_at ?? now;
  const out: PnlPoint[] = [{ t: start, cumPnlSol: 0, pnlSol: 0 }];
  let cum = 0;
  for (const t of sorted) {
    cum += t.pnl_sol;
    out.push({ t: t.closed_at, cumPnlSol: cum, pnlSol: t.pnl_sol });
  }
  out.push({ t: now, cumPnlSol: cum, pnlSol: 0 });
  return out;
}

export function rangeStart(range: string, now = Date.now()): number {
  if (range === '24h') return now - 24 * 3600_000;
  if (range === '7d') return now - 7 * 24 * 3600_000;
  return 0;
}

/** Begin van de huidige dag (lokale tijd) voor het dagelijkse verliesmaximum. */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
