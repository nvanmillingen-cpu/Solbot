import { logger } from '../logger.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Aantal extra pogingen bij netwerkfouten, 429 en 5xx. */
  retries?: number;
  /** Antwoord als ArrayBuffer i.p.v. JSON. */
  binary?: boolean;
}

/** fetch met timeout en exponentiële backoff (500ms, 1s, 2s, ...). */
export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, timeoutMs = 10_000, retries = 2, binary = false } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new HttpError(res.status, `HTTP ${res.status} ${url.split('?')[0]}: ${text.slice(0, 200)}`, text);
        // 4xx (behalve 429) heeft geen zin om te herhalen
        if (res.status !== 429 && res.status < 500) throw err;
        lastErr = err;
        if (res.status === 429) await sleep(1000 * (attempt + 1));
        continue;
      }
      return (binary ? await res.arrayBuffer() : await res.json()) as T;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Eenvoudige rate limiter (token bucket): max `perMinute` calls per minuut.
 * `take()` wacht tot er ruimte is.
 */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  /** Na een 429 even helemaal pauzeren. */
  private pausedUntil = 0;

  constructor(private perMinute: number, private name = 'api') {
    this.tokens = perMinute;
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
    this.last = now;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(this.pausedUntil - now);
        continue;
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000));
    }
  }

  backoff(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    logger.warn({ api: this.name, ms }, 'rate limit geraakt, pauzeer');
  }
}
