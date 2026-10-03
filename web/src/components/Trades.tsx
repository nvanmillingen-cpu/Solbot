import { useEffect, useState } from 'react';
import { api, fmt, signClass } from '../api';
import type { PositionRow } from '../types';
import { TokenCell } from './Positions';

const pctOf = (p: number | null, ref: number | null) => (p !== null && ref ? fmt.pct((p / ref - 1) * 100) : '–');

const REASONS: Record<string, string> = {
  SL: 'Stop-loss',
  TP: 'Take-profit',
  TIME: 'Max. houdtijd',
  TRAIL: 'Trailing stop',
  MANUAL: 'Handmatig',
  SELL_ALL: 'Sell all',
  INIT: 'Inzet eruit',
  PTP: 'Deel take-profit',
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
        <a className="btn btn-small" href="/api/trades.csv" download title="Alle trades (ook gearchiveerd) met MFE/MAE, config-hash en run-id, voor Excel">
          Download CSV
        </a>
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
                <th className="num" title="Verkoopprijs t.o.v. de prijs waarop de exit-regel triggerde">Slippage exit</th>
                <th className="num" title="Hoogste / laagste prijs tijdens het houden, t.o.v. de instapprijs (MFE / MAE)">Max / min</th>
                <th className="num" title="Hoogste prijs ná de exit (volgvenster), t.o.v. de exitprijs. 🎓 = token gegradueerd na de exit">Na exit</th>
                <th title="Config-hash van de instellingen bij aankoop">Config</th>
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
                    {r.partial_done && (
                      <span className="pill" title={`Deelverkopen vóór de eindverkoop, samen ${fmt.solPlain(r.realized_sol)} SOL`}>
                        + {r.partial_done.split(',').map((k) => (k === 'init' ? 'inzet' : `${k.slice(2)}%`)).join(', ')}
                      </span>
                    )}
                  </td>
                  <td className={`num ${r.exit_trigger_price_sol && r.exit_price_sol ? signClass(r.exit_price_sol / r.exit_trigger_price_sol - 1) : ''}`}>
                    {r.exit_trigger_price_sol && r.exit_price_sol ? fmt.pct((r.exit_price_sol / r.exit_trigger_price_sol - 1) * 100) : '–'}
                  </td>
                  <td className="num">
                    <span className="pos">{pctOf(r.peak_price_sol, r.entry_price_sol)}</span> / <span className="neg">{pctOf(r.min_price_sol, r.entry_price_sol)}</span>
                  </td>
                  <td className="num" title={r.post_watch_until && r.post_watch_until > Date.now() ? 'wordt nog gevolgd' : ''}>
                    {pctOf(r.post_max_price_sol, r.exit_price_sol)}
                    {r.post_graduated ? ' 🎓' : ''}
                  </td>
                  <td className="mono muted">{r.config_hash ?? '–'}</td>
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
