import { logger } from '../logger.js';

export type FeedName = 'solPrijs' | 'curve' | 'positiePrijzen';

interface FeedState {
  lastOkAt: number;
  failures: number;
  lastError: string;
  down: boolean;
  downSince: number;
}

/** Na zoveel opeenvolgende fouten, en zo lang geen succes, geldt een feed als uitgevallen. */
const FAIL_THRESHOLD = 3;
const STALE_MS = 15_000;

/**
 * Circuit breaker voor prijsfeeds. Logt alleen overgangen (uitgevallen / hersteld) i.p.v.
 * elke mislukte poging, en vertelt de bot of er gekocht mag worden.
 */
export class Health {
  private feeds = new Map<FeedName, FeedState>();
  /** Laatste keer dat de proces-hartslag liep (detecteert slaapstand/bevriezing). */
  lastBeatAt = Date.now();
  lastStallMs = 0;
  lastStallAt = 0;

  private get(name: FeedName): FeedState {
    let f = this.feeds.get(name);
    if (!f) {
      f = { lastOkAt: Date.now(), failures: 0, lastError: '', down: false, downSince: 0 };
      this.feeds.set(name, f);
    }
    return f;
  }

  ok(name: FeedName, now = Date.now()) {
    const f = this.get(name);
    if (f.down) logger.info({ feed: name, uitvalS: Math.round((now - f.downSince) / 1000) }, 'prijsfeed hersteld');
    Object.assign(f, { lastOkAt: now, failures: 0, lastError: '', down: false, downSince: 0 });
  }

  fail(name: FeedName, err: unknown, now = Date.now()) {
    const f = this.get(name);
    f.failures++;
    f.lastError = String(err instanceof Error ? err.message : err).slice(0, 200);
    if (!f.down && f.failures >= FAIL_THRESHOLD && now - f.lastOkAt >= STALE_MS) {
      f.down = true;
      f.downSince = now;
      logger.error({ feed: name, fouten: f.failures, err: f.lastError }, 'prijsfeed uitgevallen: nieuwe aankopen gepauzeerd, open posities onbewaakt');
    }
  }

  isDown(name: FeedName): boolean {
    return this.feeds.get(name)?.down ?? false;
  }

  /** Namen van uitgevallen feeds (leeg = alles in orde). */
  downFeeds(): FeedName[] {
    return [...this.feeds.entries()].filter(([, f]) => f.down).map(([n]) => n);
  }

  /**
   * Hartslag elke paar seconden. Een groot gat betekent dat het proces stil heeft gestaan
   * (slaapstand, pc bevroren): dan was er ook geen stop-loss-bewaking.
   */
  beat(openPositions: number, now = Date.now()) {
    const gap = now - this.lastBeatAt;
    this.lastBeatAt = now;
    if (gap > 30_000) {
      this.lastStallMs = gap;
      this.lastStallAt = now;
      logger.error(
        { stilstandMin: +(gap / 60_000).toFixed(1), openPosities: openPositions },
        'proces heeft stilgestaan (slaapstand of bevroren pc?): in die tijd werden posities NIET bewaakt',
      );
    }
  }

  view() {
    return {
      down: this.downFeeds(),
      feeds: Object.fromEntries([...this.feeds.entries()].map(([n, f]) => [n, { down: f.down, failures: f.failures, lastOkAt: f.lastOkAt, lastError: f.lastError }])),
      lastStallMs: this.lastStallMs,
      lastStallAt: this.lastStallAt,
    };
  }
}

export const health = new Health();
