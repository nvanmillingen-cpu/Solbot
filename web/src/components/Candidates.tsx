import { fmt } from '../api';
import type { Candidate } from '../types';
import { TokenCell } from './Positions';

const SOURCE: Record<string, string> = { trades: 'trades', dexscreener: 'DexScreener', curve: 'curve (schatting)', none: '–' };

export function Candidates({ candidates }: { candidates: Candidate[] }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Gevolgde tokens</h2>
        <span className="muted">Top 30, gesorteerd op aantal gehaalde filters. ✓ = voldoet aan alle filters.</span>
      </div>
      {candidates.length === 0 ? (
        <p className="muted empty">Nog geen tokens. Wacht op nieuwe tokens van de feed…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th>Token</th>
                <th className="num">Leeftijd</th>
                <th className="num">Market cap</th>
                <th className="num">Stijging</th>
                <th className="num">Vol. totaal</th>
                <th className="num">Vol. 10m</th>
                <th>Bron</th>
                <th>Grad.</th>
                <th>Filters</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map(({ metrics: m, filter }) => (
                <tr key={m.mint} className={filter.pass ? 'row-pass' : ''}>
                  <td aria-label={filter.pass ? 'voldoet' : 'voldoet niet'}>{filter.pass ? '✓' : ''}</td>
                  <td>
                    <TokenCell mint={m.mint} symbol={m.symbol} />
                  </td>
                  <td className="num">{m.ageMin !== null ? fmt.dur(m.ageMin) : '–'}</td>
                  <td className="num">{fmt.usd(m.marketCapUsd)}</td>
                  <td className="num">{fmt.pct(m.priceChangePct)}</td>
                  <td className="num">{fmt.usd(m.volumeTotalUsd)}</td>
                  <td className="num">{fmt.usd(m.volume10mUsd)}</td>
                  <td className="muted">{SOURCE[m.volumeSource]}</td>
                  <td>{m.graduated ? 'ja' : 'nee'}</td>
                  <td>
                    <div className="checks">
                      {filter.checks.map((c) => (
                        <span key={c.key} className={`chk ${c.pass ? 'ok' : 'no'}`} title={`${c.label}: ${c.value} (nodig ${c.required})`}>
                          {c.pass ? '✓' : '✗'} {c.label}
                        </span>
                      ))}
                    </div>
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
