import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { Settings } from '../types';

type Path = (string | number)[];

function getIn(o: unknown, p: Path): unknown {
  return p.reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k as string], o);
}
function setIn<T>(o: T, p: Path, v: unknown): T {
  if (!p.length) return v as T;
  const [k, ...rest] = p;
  const cur = (o as Record<string, unknown>)[k as string];
  return { ...(o as object), [k]: setIn(cur, rest, v) } as T;
}

interface Ctx {
  draft: Settings;
  set: (p: Path, v: unknown) => void;
}

function Num({ ctx, path, label, unit, step = 'any', min = 0, hint }: { ctx: Ctx; path: Path; label: string; unit?: string; step?: string; min?: number; hint?: string }) {
  const v = getIn(ctx.draft, path) as number;
  const id = path.join('.');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-unit">
        <input id={id} type="number" step={step} min={min} value={Number.isFinite(v) ? v : ''} onChange={(e) => ctx.set(path, e.target.value === '' ? NaN : Number(e.target.value))} />
        {unit && <span className="unit">{unit}</span>}
      </div>
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

function Toggle({ ctx, path, label, children, hint }: { ctx: Ctx; path: Path; label: string; children?: ReactNode; hint?: string }) {
  const on = getIn(ctx.draft, [...path, 'enabled']) as boolean;
  const id = [...path, 'enabled'].join('.');
  return (
    <div className={`rule ${on ? '' : 'rule-off'}`}>
      <label className="rule-head" htmlFor={id}>
        <input id={id} type="checkbox" checked={on} onChange={(e) => ctx.set([...path, 'enabled'], e.target.checked)} />
        <span>{label}</span>
      </label>
      {hint && <small className="muted">{hint}</small>}
      <div className="rule-body">{children}</div>
    </div>
  );
}

function Check({ ctx, path, label, hint }: { ctx: Ctx; path: Path; label: string; hint?: string }) {
  const id = path.join('.');
  return (
    <div className="check-row">
      <label className="rule-head" htmlFor={id}>
        <input id={id} type="checkbox" checked={Boolean(getIn(ctx.draft, path))} onChange={(e) => ctx.set(path, e.target.checked)} />
        <span>{label}</span>
      </label>
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

function Select({ ctx, path, label, options }: { ctx: Ctx; path: Path; label: string; options: [string, string][] }) {
  const id = path.join('.');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={String(getIn(ctx.draft, path))} onChange={(e) => ctx.set(path, e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SettingsPanel({ onError }: { onError: (e: string | null) => void }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<Settings>('/api/settings').then((s) => {
      setSaved(s);
      setDraft(s);
    });
  }, []);

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  if (!draft) return <p className="muted">Laden…</p>;
  const ctx: Ctx = { draft, set: (p, v) => setDraft((d) => (d ? setIn(d, p, v) : d)) };

  const apply = async () => {
    setBusy(true);
    try {
      // paperMode wordt via de schakelaar bovenin gewijzigd
      const { general, ...rest } = draft;
      const { paperMode: _ignored, ...gen } = general;
      const next = await api.put<Settings>('/api/settings', { ...rest, general: gen });
      setSaved(next);
      setDraft(next);
      setMsg('Toegepast. Wijzigingen gelden direct.');
      onError(null);
      setTimeout(() => setMsg(null), 4000);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings">
      <div className="settings-bar">
        <span className="muted">{dirty ? 'Niet-opgeslagen wijzigingen' : 'Alle wijzigingen opgeslagen'}</span>
        {msg && <span className="ok-msg">{msg}</span>}
        <button className="btn" disabled={!dirty || busy} onClick={() => setDraft(saved)}>
          Herstel
        </button>
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={apply}>
          Toepassen
        </button>
      </div>

      <section className="card">
        <h2>Filters (kopen)</h2>
        <p className="muted">Een token wordt alleen gekocht als het aan álle ingeschakelde filters voldoet. Onbekende data telt als niet voldoen.</p>
        <div className="grid">
          <Toggle ctx={ctx} path={['filters', 'priceChange']} label="Top % (prijsstijging)" hint="Stijging binnen het venster, of sinds lancering als het token jonger is.">
            <Num ctx={ctx} path={['filters', 'priceChange', 'minPct']} label="Minimaal" unit="%" min={-100} />
            <Num ctx={ctx} path={['filters', 'priceChange', 'windowMin']} label="Venster" unit="min" />
          </Toggle>
          <Toggle ctx={ctx} path={['filters', 'volumeTotal']} label="Volume totaal">
            <Num ctx={ctx} path={['filters', 'volumeTotal', 'minUsd']} label="Minimaal" unit="USD" />
          </Toggle>
          <Toggle ctx={ctx} path={['filters', 'volume10m']} label="Volume laatste 10 min">
            <Num ctx={ctx} path={['filters', 'volume10m', 'minUsd']} label="Minimaal" unit="USD" />
          </Toggle>
          <Toggle ctx={ctx} path={['filters', 'marketCap']} label="Market cap">
            <Num ctx={ctx} path={['filters', 'marketCap', 'minUsd']} label="Min" unit="USD" />
            <Num ctx={ctx} path={['filters', 'marketCap', 'maxUsd']} label="Max (0 = geen)" unit="USD" />
          </Toggle>
          <div className="rule">
            <Select
              ctx={ctx}
              path={['filters', 'graduated']}
              label="Graduated (bonding curve voltooid)"
              options={[
                ['any', 'Maakt niet uit'],
                ['no', 'Nee (alleen bonding curve)'],
                ['yes', 'Ja (alleen gegradueerd)'],
              ]}
            />
          </div>
          <Toggle ctx={ctx} path={['filters', 'minAge']} label="Minimale leeftijd">
            <Num ctx={ctx} path={['filters', 'minAge', 'minutes']} label="Minimaal" unit="min" />
          </Toggle>
          <Toggle ctx={ctx} path={['filters', 'maxAge']} label="Maximale leeftijd">
            <Num ctx={ctx} path={['filters', 'maxAge', 'minutes']} label="Maximaal" unit="min" />
          </Toggle>
          <Toggle
            ctx={ctx}
            path={['filters', 'minHolders']}
            label="Minimaal aantal holders"
            hint="Zonder PumpPortal API-sleutel via RPC: telt max. 20 holders, dus waarden boven 20 halen nooit."
          >
            <Num ctx={ctx} path={['filters', 'minHolders', 'count']} label="Minimaal" step="1" />
          </Toggle>
        </div>
      </section>

      <section className="card">
        <h2>Exit-regels</h2>
        <p className="muted">Zodra één ingeschakelde regel geraakt wordt, verkoopt de bot. Een mislukte verkoop wordt automatisch opnieuw geprobeerd.</p>
        <div className="grid">
          <Toggle ctx={ctx} path={['exits', 'stopLoss']} label="Stop-loss">
            <Num ctx={ctx} path={['exits', 'stopLoss', 'pct']} label="Verlies" unit="%" />
          </Toggle>
          <Toggle ctx={ctx} path={['exits', 'takeProfit']} label="Take-profit">
            <Num ctx={ctx} path={['exits', 'takeProfit', 'pct']} label="Winst" unit="%" />
          </Toggle>
          <Toggle ctx={ctx} path={['exits', 'maxHold']} label="Maximale houdtijd">
            <Num ctx={ctx} path={['exits', 'maxHold', 'minutes']} label="Maximaal" unit="min" />
          </Toggle>
          <Toggle ctx={ctx} path={['exits', 'trailingStop']} label="Trailing stop" hint="Verkoopt als de prijs dit % onder de hoogste prijs sinds aankoop zakt.">
            <Num ctx={ctx} path={['exits', 'trailingStop', 'pct']} label="Daling vanaf top" unit="%" />
          </Toggle>
        </div>
      </section>

      <section className="card">
        <h2>Risico</h2>
        <div className="grid">
          <div className="rule">
            <Num ctx={ctx} path={['risk', 'solPerTrade']} label="SOL per trade" unit="SOL" />
            <Num ctx={ctx} path={['risk', 'maxOpenPositions']} label="Max. gelijktijdige posities" step="1" min={1} />
            <Num ctx={ctx} path={['risk', 'minSolReserve']} label="Minimale SOL-reserve in wallet" unit="SOL" />
          </div>
          <Toggle ctx={ctx} path={['risk', 'dailyLossLimit']} label="Dagelijks verliesmaximum" hint="Stopt met kopen als het gerealiseerde verlies vandaag dit bedrag bereikt.">
            <Num ctx={ctx} path={['risk', 'dailyLossLimit', 'sol']} label="Maximaal verlies" unit="SOL" />
          </Toggle>
        </div>
      </section>

      <section className="card">
        <h2>Uitvoering</h2>
        <div className="grid">
          <div className="rule">
            <Select
              ctx={ctx}
              path={['general', 'executor']}
              label="Executor (live)"
              options={[
                ['jupiter', 'Jupiter (geen extra fee), fallback PumpPortal'],
                ['pumpportal', 'PumpPortal (0,5% fee), fallback Jupiter'],
              ]}
            />
            <Num ctx={ctx} path={['general', 'slippagePct']} label="Slippage" unit="%" />
            <Num ctx={ctx} path={['general', 'priorityFeeSol']} label="Priority fee (max)" unit="SOL" />
            <Num ctx={ctx} path={['general', 'maxTxRetries']} label="Max. herhalingen bij mislukte tx" step="1" />
          </div>
          <div className="rule">
            <h3>Veiligheid</h3>
            <Check ctx={ctx} path={['safety', 'requireRevokedAuthorities']} label="Mint- en freeze-authority moeten ingetrokken zijn" />
            <Check ctx={ctx} path={['safety', 'sellQuoteCheck']} label="Verkoop-quote moet slagen vóór aankoop (honeypot-check)" />
            <Num ctx={ctx} path={['safety', 'maxRoundTripLossPct']} label="Max. verlies kopen→direct verkopen" unit="%" />
          </div>
          <Toggle ctx={ctx} path={['safety', 'minLiquidityUsd']} label="Minimale liquiditeit (graduated tokens)">
            <Num ctx={ctx} path={['safety', 'minLiquidityUsd', 'usd']} label="Minimaal" unit="USD" />
          </Toggle>
          <div className="rule">
            <h3>Datafeed</h3>
            <Num ctx={ctx} path={['tracker', 'watchWindowMin']} label="Token volgen gedurende" unit="min" />
            <Num ctx={ctx} path={['tracker', 'curvePollSec']} label="Bonding curve pollen elke" unit="s" />
            <Num ctx={ctx} path={['tracker', 'dexPollSec']} label="DexScreener pollen elke" unit="s" />
            <Num ctx={ctx} path={['tracker', 'positionPollSec']} label="Posities controleren elke" unit="s" />
            <Num ctx={ctx} path={['tracker', 'maxTrackedTokens']} label="Max. gevolgde tokens" step="1" />
          </div>
        </div>
      </section>
    </div>
  );
}
