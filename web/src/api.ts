async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data as { error?: string; details?: string[] };
    throw new Error([d.error ?? `HTTP ${res.status}`, ...(d.details ?? [])].join('\n'));
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => req<T>('GET', url),
  post: <T>(url: string, body?: unknown) => req<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => req<T>('PUT', url, body),
};

export const fmt = {
  sol: (n: number | null | undefined, d = 4) => (n === null || n === undefined ? '–' : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}`),
  solPlain: (n: number | null | undefined, d = 4) => (n === null || n === undefined ? '–' : n.toFixed(d)),
  pct: (n: number | null | undefined, d = 1) => (n === null || n === undefined ? '–' : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}%`),
  pctPlain: (n: number | null | undefined, d = 0) => (n === null || n === undefined ? '–' : `${n.toFixed(d)}%`),
  usd: (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('nl-NL')}`),
  price: (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toExponential(3)),
  dur: (min: number) => (min < 60 ? `${Math.floor(min)}m ${Math.floor((min % 1) * 60)}s` : `${Math.floor(min / 60)}u ${Math.floor(min % 60)}m`),
  /** Looptijd als 1u 02m 03s (of 2d 3u 04m). */
  elapsed: (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const p = (n: number) => String(n).padStart(2, '0');
    return d ? `${d}d ${h}u ${p(m)}m` : h ? `${h}u ${p(m)}m ${p(s % 60)}s` : `${m}m ${p(s % 60)}s`;
  },
  time: (t: number | null | undefined) => (t ? new Date(t).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–'),
};

export const signClass = (n: number | null | undefined) => (n === null || n === undefined || n === 0 ? '' : n > 0 ? 'pos' : 'neg');
