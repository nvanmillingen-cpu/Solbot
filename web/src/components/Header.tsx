import { fmt } from '../api';
import type { BotState } from '../types';

interface Props {
  state: BotState | null;
  connected: boolean;
  onStart: () => void;
  onStop: () => void;
  onSellAll: () => void;
  onToggleMode: (paper: boolean) => void;
}

export function Header({ state, connected, onStart, onStop, onSellAll, onToggleMode }: Props) {
  const live = state?.mode === 'live';
  return (
    <header className="header">
      <div className="brand">
        <span className="logo" aria-hidden>◎</span>
        <h1>Solbot</h1>
        {state && (
          <span className={`badge ${live ? 'badge-live' : 'badge-paper'}`} title={live ? 'Echte transacties' : 'Gesimuleerde trades op live prijzen'}>
            {live ? 'LIVE' : 'PAPER'}
          </span>
        )}
        <span className={`status ${state?.running ? 'on' : 'off'}`}>
          <span className="status-dot" aria-hidden />
          {state?.running ? 'Actief' : 'Gestopt'}
          {state?.running && state.runningSince && (
            <span className="run-timer mono" title={`Gestart op ${new Date(state.runningSince).toLocaleString('nl-NL')}`}>
              {fmt.elapsed(state.now - state.runningSince)}
            </span>
          )}
        </span>
      </div>

      <div className="meta">
        <span title="Verbinding dashboard ↔ bot">{connected ? 'Dashboard verbonden' : 'Dashboard niet verbonden'}</span>
        <span title="PumpPortal datafeed">
          Feed: {state?.feed.connected ? 'verbonden' : 'offline'}
          {state?.feed.rpcFallbackActive ? ' + RPC-fallback' : ''}
        </span>
        <span>Gevolgd: {state?.tracker.tracked ?? '–'} tokens</span>
        {state && (
          <span title={`Hash van de huidige instellingen. Vergelijk resultaten pas na ~200–300 trades met dezelfde instellingen. Run: ${state.run.id}`}>
            Config <span className="mono">{state.config.hash}</span>: {state.config.trades}/200 trades
          </span>
        )}
        <span>SOL ${state?.solUsd ? state.solUsd.toFixed(2) : '–'}</span>
        {state?.wallet && (
          <span title={state.wallet.address}>
            Wallet {state.wallet.address.slice(0, 4)}…{state.wallet.address.slice(-4)}: {fmt.solPlain(state.wallet.sol, 3)} SOL
          </span>
        )}
      </div>

      <div className="controls">
        {state && (
          <label className="switch" title={!state.liveTradingEnabled ? 'Zet LIVE_TRADING_ENABLED=true in .env om live te kunnen handelen' : ''}>
            <input
              type="checkbox"
              checked={!live}
              disabled={state.running || (!live && (!state.liveTradingEnabled || !state.wallet))}
              onChange={(e) => onToggleMode(e.target.checked)}
            />
            Paper mode
          </label>
        )}
        {state?.running ? (
          <button className="btn" onClick={onStop}>
            ■ Stop
          </button>
        ) : (
          <button className="btn btn-primary" onClick={onStart} disabled={!state}>
            ▶ Start
          </button>
        )}
        <button className="btn btn-danger" onClick={onSellAll} disabled={!state?.positions.length}>
          Sell all
        </button>
      </div>
      {state?.blocker && <div className="blocker">Kopen gepauzeerd: {state.blocker}</div>}
      {state && state.health.lastStallAt > 0 && state.now - state.health.lastStallAt < 30 * 60_000 && (
        <div className="blocker">
          De bot heeft {Math.round(state.health.lastStallMs / 60_000)} min stilgestaan (slaapstand of bevroren pc?). In die tijd werden posities niet bewaakt.
        </div>
      )}
      {state?.top10.enabled && state.top10.ok === false && (
        <div className="blocker">
          Top-10-holdercheck werkt niet met deze RPC
          {state.top10.required ? ': er wordt niets gekocht tot dit opgelost is' : ' en wordt overgeslagen'}. Zet een Helius/QuickNode-URL in RPC_URL (.env). Fout:{' '}
          {state.top10.lastError}
        </div>
      )}
    </header>
  );
}
