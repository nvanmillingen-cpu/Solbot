import { useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, fmt } from '../api';
import type { PnlPoint, TradeStats } from '../types';

const RANGES = [
  { key: '24h', label: '24 uur' },
  { key: '7d', label: '7 dagen' },
  { key: 'all', label: 'All-time' },
];

export function PnlChart({ mode, refreshKey }: { mode: string; refreshKey: string }) {
  const [range, setRange] = useState('24h');
  const [data, setData] = useState<PnlPoint[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    void api.get<PnlPoint[]>(`/api/pnl?range=${range}&mode=${mode}`).then(setData).catch(() => undefined);
    void api.get<TradeStats>(`/api/stats?range=${range}&mode=${mode}`).then(setStats).catch(() => undefined);
  }, [range, mode, refreshKey]);

  const last = data.at(-1)?.cumPnlSol ?? 0;
  const tickFmt = (t: number) =>
    new Date(t).toLocaleString('nl-NL', range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit' });

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          Gerealiseerde P&L <span className="muted">({mode})</span>
        </h2>
        <div className="seg" role="group" aria-label="Periode">
          {RANGES.map((r) => (
            <button key={r.key} className={range === r.key ? 'active' : ''} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="hero">
        <span className={`hero-value ${last > 0 ? 'pos' : last < 0 ? 'neg' : ''}`}>{fmt.sol(last)} SOL</span>
        {stats && (
          <span className="muted">
            {stats.totalTrades} trades · win rate {stats.totalTrades ? stats.winRatePct.toFixed(0) : '–'}% · gem. {fmt.pct(stats.avgPnlPct)}
          </span>
        )}
      </div>
      {data.length <= 2 ? (
        <p className="muted empty">Nog geen gesloten trades in deze periode.</p>
      ) : (
        <div className="chart" aria-label="Cumulatieve gerealiseerde P&L in SOL">
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tickFmt} stroke="var(--muted)" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={40} />
              <YAxis stroke="var(--muted)" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => v.toFixed(3)} />
              <ReferenceLine y={0} stroke="var(--muted)" strokeDasharray="3 3" />
              <Tooltip
                cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }}
                contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }}
                labelFormatter={(t) => fmt.time(Number(t))}
                formatter={(v, name) => [`${fmt.sol(Number(v))} SOL`, name === 'cumPnlSol' ? 'Cumulatief' : String(name)]}
              />
              <Area type="stepAfter" dataKey="cumPnlSol" stroke="var(--series-1)" strokeWidth={2} fill="url(#pnlFill)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
      {data.length > 2 && (
        <button className="link" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Verberg tabel' : 'Toon als tabel'}
        </button>
      )}
      {showTable && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tijd</th>
                <th className="num">Trade P&L</th>
                <th className="num">Cumulatief</th>
              </tr>
            </thead>
            <tbody>
              {data.slice(1, -1).map((p) => (
                <tr key={p.t}>
                  <td>{fmt.time(p.t)}</td>
                  <td className="num">{fmt.sol(p.pnlSol)}</td>
                  <td className="num">{fmt.sol(p.cumPnlSol)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
