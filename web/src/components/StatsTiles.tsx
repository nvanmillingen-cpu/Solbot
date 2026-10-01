import { fmt, signClass } from '../api';
import type { BotState } from '../types';

export function StatsTiles({ state }: { state: BotState }) {
  const s = state.stats;
  const openPnl = state.positions.reduce((a, p) => a + (p.livePnlSol ?? 0), 0);
  const tiles: { label: string; value: string; cls?: string; sub?: string }[] = [
    { label: 'Totale P&L', value: `${fmt.sol(s.totalPnlSol)} SOL`, cls: signClass(s.totalPnlSol), sub: state.solUsd ? fmt.usd(s.totalPnlSol * state.solUsd) : undefined },
    { label: 'Trades', value: String(s.totalTrades), sub: `${s.wins} winst · ${s.losses} verlies` },
    { label: 'Win rate', value: s.totalTrades ? `${s.winRatePct.toFixed(1)}%` : '–' },
    { label: 'Gem. P&L per trade', value: s.totalTrades ? fmt.pct(s.avgPnlPct) : '–', cls: signClass(s.avgPnlPct), sub: s.totalTrades ? `${fmt.sol(s.avgPnlSol)} SOL` : undefined },
    { label: 'Open posities', value: `${state.positions.length} / ${state.maxOpenPositions}`, sub: state.positions.length ? `${fmt.sol(openPnl)} SOL open` : undefined },
  ];
  return (
    <section className="tiles" aria-label={`Statistieken (${state.mode})`}>
      {tiles.map((t) => (
        <div className="tile" key={t.label}>
          <div className="tile-label">{t.label}</div>
          <div className={`tile-value ${t.cls ?? ''}`}>{t.value}</div>
          {t.sub && <div className="tile-sub">{t.sub}</div>}
        </div>
      ))}
    </section>
  );
}
