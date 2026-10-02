import { describe, expect, it, vi } from 'vitest';

const sol = { ageMs: 1000 };
vi.mock('../src/market/solPrice.js', () => ({
  solUsd: vi.fn(async () => 150),
  solUsdCached: () => 150,
  solUsdAgeMs: () => sol.ageMs,
}));

const { openDb } = await import('../src/db.js');
const { SettingsStore } = await import('../src/settings.js');
const { Bot } = await import('../src/core/bot.js');
const { health } = await import('../src/core/health.js');
const { top10Status } = await import('../src/core/safety.js');

function bot() {
  const db = openDb(':memory:');
  const store = new SettingsStore(db);
  const positions = { open: () => [], realizedSince: () => 0 } as never;
  return new Bot(db, {} as never, store, {} as never, positions, null, () => null);
}

describe('koopblokkades (fail-closed)', () => {
  it('alles in orde → kopen mag', () => {
    top10Status.ok = true;
    expect(bot().buyBlocker()).toBeNull();
  });

  it('top-10-check werkt niet (eerste start met publieke RPC) → niet kopen', () => {
    Object.assign(top10Status, { ok: false, lastError: '429 Too Many Requests' });
    expect(bot().buyBlocker()).toMatch(/top-10-holdercheck werkt niet/);
    top10Status.ok = true;
  });

  it('SOL-prijs te oud → niet kopen', () => {
    sol.ageMs = 6 * 60_000;
    expect(bot().buyBlocker()).toMatch(/SOL-prijs/);
    sol.ageMs = 1000;
  });

  it('prijsfeed uitgevallen (DNS ENOTFOUND) → niet kopen', () => {
    const t = Date.now();
    health.ok('curve', t - 60_000);
    for (let i = 0; i < 3; i++) health.fail('curve', 'getaddrinfo ENOTFOUND', t - 10_000 + i);
    expect(bot().buyBlocker()).toMatch(/prijsfeed uitgevallen \(curve\)/);
    health.ok('curve');
    expect(bot().buyBlocker()).toBeNull();
  });
});
