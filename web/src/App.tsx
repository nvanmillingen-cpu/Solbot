import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { BotState, Candidate, LogEntry } from './types';
import { Header } from './components/Header';
import { StatsTiles } from './components/StatsTiles';
import { PnlChart } from './components/PnlChart';
import { Positions } from './components/Positions';
import { Trades } from './components/Trades';
import { SettingsPanel } from './components/SettingsPanel';
import { Candidates } from './components/Candidates';
import { Logs } from './components/Logs';

type Tab = 'overzicht' | 'instellingen' | 'kandidaten' | 'log';

function useLiveState() {
  const [state, setState] = useState<BotState | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket;
    let retry: number;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'state') {
          setState(m.state);
          setCandidates(m.candidates);
          setLogs(m.logs);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
  return { state, candidates, logs, connected };
}

export function App() {
  const { state, candidates, logs, connected } = useLiveState();
  const [tab, setTab] = useState<Tab>('overzicht');
  const [error, setError] = useState<string | null>(null);
  // Na een sluiting de grafiek/historie verversen
  const closedCount = state?.stats.totalTrades ?? 0;
  const [resetCount, setResetCount] = useState(0);
  const refreshKey = `${state?.mode}-${closedCount}-${resetCount}`;
  const errTimer = useRef<number>(undefined);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError((e as Error).message);
      clearTimeout(errTimer.current);
      errTimer.current = window.setTimeout(() => setError(null), 8000);
    }
  };

  return (
    <div className="app">
      <Header
        state={state}
        connected={connected}
        onStart={() => run(() => api.post('/api/bot/start'))}
        onStop={() => run(() => api.post('/api/bot/stop'))}
        onSellAll={() => {
          if (confirm('Alle open posities direct verkopen en de bot stoppen?')) void run(() => api.post('/api/positions/sell-all'));
        }}
        onToggleMode={(paper) => {
          const msg = paper
            ? 'Terug naar paper mode?'
            : 'LET OP: live mode gebruikt echt geld uit je wallet. Weet je het zeker?';
          if (confirm(msg)) void run(() => api.put('/api/settings', { general: { paperMode: paper } }));
        }}
      />
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <nav className="tabs" role="tablist">
        {(['overzicht', 'instellingen', 'kandidaten', 'log'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
            {t === 'kandidaten' && candidates.some((c) => c.filter.pass) ? <span className="dot" aria-label="kandidaten gevonden" /> : null}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'overzicht' && state && (
          <>
            <StatsTiles state={state} />
            <PnlChart mode={state.mode} refreshKey={refreshKey} />
            <Positions positions={state.positions} max={state.maxOpenPositions} onSell={(id) => run(() => api.post(`/api/positions/${id}/sell`))} />
            <Trades
              mode={state.mode}
              refreshKey={refreshKey}
              onReset={(mode) =>
                run(async () => {
                  await api.post('/api/stats/reset', { mode });
                  setResetCount((n) => n + 1);
                })
              }
              onResetLogs={() =>
                run(async () => {
                  const r = await api.post<{ deleted: number; failed: string[] }>('/api/logs/reset');
                  if (r.failed.length) throw new Error(`Niet alle logbestanden konden verwijderd worden: ${r.failed.join(', ')}`);
                })
              }
            />
          </>
        )}
        {tab === 'instellingen' && <SettingsPanel onError={setError} />}
        {tab === 'kandidaten' && <Candidates candidates={candidates} />}
        {tab === 'log' && <Logs logs={logs} />}
        {!state && <p className="muted">Verbinden met de bot…</p>}
      </main>
    </div>
  );
}
