import { useEffect, useState } from 'react';
import { api, fmt, signClass } from '../api';
import type { PositionRow } from '../types';
import { TokenCell } from './Positions';

const REASONS: Record<string, string> = {
  SL: 'Stop-loss',
  TP: 'Take-profit',
  TIME: 'Max. houdtijd',
  TRAIL: 'Trailing stop',
  MANUAL: 'Handmatig',
  SELL_ALL: 'Sell all',
};

export function Trades({ mode, refreshKey, onReset }: { mode: string; refreshKey: string; onReset: (mode: string) => void }) {
  const [rows, setRows] = useState<PositionRow[]>([]);
  const [filterMode, setFilterMode] = useState<string>(mode);
  useEffect(() => setFilterMode(mode), [mode]);
  useEffect(() => {
    void api.get<PositionRow[]>(`/api/trades?mode=${filterMode}&limit=200`).then(setRows).catch(() => undefined);
  }, [filterMode, refreshKey]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Tradehistorie</h2>
        <div className="head-actions">
        <button
          className="btn btn-small"
          disabled={rows.length === 0}
          onClick={() => {
            const label = filterMode === 'all' ? 'paper én live' : filterMode;
            if (confirm(`Statistieken resetten voor ${label}?\n\nGesloten trades worden gearchiveerd (niet verwijderd) en tellen niet meer mee. Instellingen en open posities blijven staan.`)) onReset(filterMode);
          }}
        >
          Reset statistieken
        </button>
        <div className="seg" role="group" aria-label="Modus">
          {['paper', 'live', 'all'].map((m) => (
            <button key={m} className={filterMode === m ? 'active' : ''} aria-pressed={filterMode === m} onClick={() => setFilterMode(m)}>
              {m === 'all' ? 'Alles' : m}
            </button>
          ))}
        </div>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="muted empty">Nog geen gesloten trades.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Gesloten</th>
                <th>Token</th>
                <th>Modus</th>
                <th className="num">In (SOL)</th>
                <th className="num">Uit (SOL)</th>
                <th className="num">P&L %</th>
                <th className="num">P&L SOL</th>
                <th className="num">Duur</th>
                <th>Reden</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{fmt.time(r.closed_at)}</td>
                  <td>
                    <TokenCell mint={r.mint} symbol={r.symbol} />
                  </td>
                  <td>{r.mode}</td>
                  <td className="num">{fmt.solPlain(r.entry_sol)}</td>
                  <td className="num">{fmt.solPlain(r.exit_sol)}</td>
                  <td className={`num ${signClass(r.pnl_pct)}`}>{fmt.pct(r.pnl_pct)}</td>
                  <td className={`num ${signClass(r.pnl_sol)}`}>{fmt.sol(r.pnl_sol)}</td>
                  <td className="num">{r.closed_at ? fmt.dur((r.closed_at - r.opened_at) / 60_000) : '–'}</td>
                  <td>
                    <span className="pill">{REASONS[r.exit_reason ?? ''] ?? r.exit_reason}</span>
                  </td>
                  <td>
                    {r.sell_sig ? (
                      <a href={`https://solscan.io/tx/${r.sell_sig}`} target="_blank" rel="noreferrer">
                        solscan
                      </a>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
