import type { LogEntry } from '../types';

export function Logs({ logs }: { logs: LogEntry[] }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Log</h2>
        <span className="muted">Laatste {logs.length} regels. Volledige log staat in de map logs/.</span>
      </div>
      <div className="log" role="log">
        {[...logs].reverse().map((l, i) => (
          <div key={`${l.time}-${i}`} className={`log-line lvl-${l.level}`}>
            <span className="muted mono">{new Date(l.time).toLocaleTimeString('nl-NL')}</span> <span className="lvl">{l.level.toUpperCase()}</span> {l.msg}
          </div>
        ))}
      </div>
    </section>
  );
}
