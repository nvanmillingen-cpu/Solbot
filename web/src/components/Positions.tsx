import { fmt, signClass } from '../api';
import type { OpenPositionView } from '../types';

const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;

export function TokenCell({ mint, symbol }: { mint: string; symbol: string | null }) {
  return (
    <span className="token">
      <strong>{symbol || short(mint)}</strong>{' '}
      <a href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer" className="muted mono" title={mint}>
        {short(mint)}
      </a>
    </span>
  );
}

export function Positions({ positions, max, onSell }: { positions: OpenPositionView[]; max: number; onSell: (id: number) => void }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          Open posities <span className="muted">({positions.length}/{max})</span>
        </h2>
      </div>
      {positions.length === 0 ? (
        <p className="muted empty">Geen open posities.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Modus</th>
                <th className="num">Inleg</th>
                <th className="num">Instapprijs</th>
                <th className="num">Huidige prijs</th>
                <th className="num">P&L %</th>
                <th className="num">P&L SOL</th>
                <th className="num">Open</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.id}>
                  <td>
                    <TokenCell mint={p.mint} symbol={p.symbol} />
                  </td>
                  <td>{p.mode}</td>
                  <td className="num">{fmt.solPlain(p.entry_sol)}</td>
                  <td className="num mono">{fmt.price(p.entry_price_sol)}</td>
                  <td className="num mono">{fmt.price(p.last_price_sol)}</td>
                  <td className={`num ${signClass(p.livePnlPct)}`}>{fmt.pct(p.livePnlPct)}</td>
                  <td className={`num ${signClass(p.livePnlSol)}`}>{fmt.sol(p.livePnlSol)}</td>
                  <td className="num">{fmt.dur(p.heldMin)}</td>
                  <td>
                    {p.unmonitored && p.status === 'open' && (
                      <span className="pill pill-warn" title="Geen verse prijs: stop-loss en andere exit-regels kunnen nu niet op tijd vuren">
                        ⚠ onbewaakt{p.priceAgeS !== null ? ` (${p.priceAgeS}s)` : ''}
                      </span>
                    )}{' '}
                    {p.status === 'closing' ? (
                      <span className="pill">verkopen…</span>
                    ) : p.pending_exit ? (
                      <span className="pill pill-warn" title={p.last_error ?? ''}>
                        ⚠ verkoop mislukt ({p.sell_attempts}×), opnieuw
                      </span>
                    ) : (
                      <span className="pill">open</span>
                    )}
                  </td>
                  <td>
                    <button className="btn btn-small" disabled={p.status !== 'open'} onClick={() => confirm(`${p.symbol ?? p.mint} nu verkopen?`) && onSell(p.id)}>
                      Verkoop
                    </button>
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
