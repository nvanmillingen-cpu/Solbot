import { PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Jupiter-quotes nabootsen (geen netwerk in tests)
const quoteState = { buyPriceFactor: 1.013, fail: false };
vi.mock('../src/market/jupiter.js', () => ({
  jupQuote: vi.fn(async (input: string, _out: string, amount: bigint) => {
    if (quoteState.fail) throw new Error('geen route');
    const SOL = 'So11111111111111111111111111111111111111112';
    const price = 3e-8 * quoteState.buyPriceFactor; // SOL per token
    if (input === SOL) return { outAmount: String(Math.floor((Number(amount) / 1e9 / price) * 1e6)) };
    return { outAmount: String(Math.floor((Number(amount) / 1e6) * 3e-8 * 0.975 * 1e9)) };
  }),
}));

const { preBuyChecks, top10FromAccounts, associatedTokenAddress, top10Status } = await import('../src/core/safety.js');
const { bondingCurvePda, curvePriceSol } = await import('../src/market/bondingCurve.js');
const { defaultSettings } = await import('../src/settings.js');

const MINT = 'F88arSQwXW7CZYw5ngsuftrDC5onhHHLmTj1jM2Gpump';
const CREATOR = new PublicKey('9HsdfT7phLNwTwQvvtXza6ywxodC9dT9MyuKrRLs1d31');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SUPPLY = 1_000_000_000_000_000n; // 1 mld × 10^6

function curveBuf(opts: { complete?: boolean; mayhem?: boolean } = {}) {
  const b = Buffer.alloc(151);
  // vSol/vTok zo gekozen dat de prijs 3e-8 SOL per token is
  const vals = [1_000_000_000_000_000n, 30_000_000_000n, 720_000_000_000_000n, 5_000_000_000n, SUPPLY];
  vals.forEach((v, i) => b.writeBigUInt64LE(v, 8 + i * 8));
  b[48] = opts.complete ? 1 : 0;
  CREATOR.toBuffer().copy(b, 49);
  b[81] = opts.mayhem ? 1 : 0;
  return b;
}

interface FakeOpts {
  curve?: Buffer | null;
  largest?: () => { address: PublicKey; amount: string }[];
  creatorRaw?: bigint;
}

function fakeConn(o: FakeOpts) {
  const calls = { largest: 0 };
  const curveAta = associatedTokenAddress(bondingCurvePda(MINT), new PublicKey(MINT), TOKEN_PROGRAM);
  const conn = {
    rpcEndpoint: 'fake',
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => (o.curve === null ? null : { data: o.curve ?? curveBuf() })),
    getParsedAccountInfo: async () => ({
      value: { owner: TOKEN_PROGRAM, data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: SUPPLY.toString() } } } },
    }),
    getAccountInfo: async () => {
      const d = Buffer.alloc(165);
      d.writeBigUInt64LE(o.creatorRaw ?? 0n, 64);
      return { data: d };
    },
    getTokenLargestAccounts: async () => {
      calls.largest++;
      return { value: o.largest ? o.largest() : [{ address: curveAta, amount: '700000000000000' }, { address: CREATOR, amount: '50000000000000' }] };
    },
  };
  return { conn: conn as never, calls, curveAta };
}

const metrics = (over: Record<string, unknown> = {}) => ({
  mint: MINT,
  symbol: 'TST',
  name: 'Test',
  ageMin: 5,
  graduated: false,
  onCurve: true,
  mayhem: false,
  priceSol: 3e-8,
  marketCapUsd: 20_000,
  priceChangePct: 50,
  volumeTotalUsd: 10_000,
  volume10mUsd: 5_000,
  volumeSource: 'curve' as const,
  holders: null,
  holdersCapped: false,
  liquidityUsd: 1000,
  ...over,
});

const err429 = () => {
  throw new Error('429 Too Many Requests: {"code": 429, "message":"Too many requests for a specific RPC call"}');
};

describe('preBuyChecks', () => {
  beforeEach(() => {
    quoteState.buyPriceFactor = 1.013;
    quoteState.fail = false;
  });

  it('keurt een gezond token goed en meet top-10 zonder de bonding curve', async () => {
    const { conn } = fakeConn({});
    const r = await preBuyChecks(conn, defaultSettings(), metrics(), 0.05, CREATOR.toBase58());
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.top10Pct).toBeCloseTo(5, 6); // alleen de 5% van de maker, niet de 70% van de curve
  });

  it('top-10: herhaalt bij 429 en slaagt bij de derde poging', async () => {
    let n = 0;
    const { conn, calls } = fakeConn({
      largest: () => {
        if (++n < 3) err429();
        return [{ address: CREATOR, amount: '10000000000000' }];
      },
    });
    const r = await preBuyChecks(conn, defaultSettings(), metrics(), 0.05);
    expect(calls.largest).toBe(3);
    expect(r.top10Pct).not.toBeNull();
    expect(r.ok).toBe(true);
    expect(top10Status.ok).toBe(true);
  });

  it('top-10: keurt af als de RPC blijft weigeren (fail-closed, standaard)', async () => {
    const { conn, calls } = fakeConn({ largest: err429 });
    const r = await preBuyChecks(conn, defaultSettings(), metrics(), 0.05);
    expect(calls.largest).toBe(3);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain('top-10-holders onbekend');
    expect(top10Status.ok).toBe(false);
  });

  it('top-10: met requireData uit wordt een onbekende top-10 overgeslagen', async () => {
    const s = defaultSettings();
    s.safety.maxTop10Pct.requireData = false;
    const { conn } = fakeConn({ largest: err429 });
    const r = await preBuyChecks(conn, s, metrics(), 0.05);
    expect(r.ok).toBe(true);
    expect(r.top10Pct).toBeNull();
  });

  it('top-10: keurt af boven de grens', async () => {
    const holders = Array.from({ length: 10 }, () => ({ address: PublicKey.unique(), amount: '40000000000000' })); // 10 × 4% = 40%
    const { conn, curveAta } = fakeConn({ largest: () => [{ address: curveAta, amount: '500000000000000' }, ...holders] });
    const r = await preBuyChecks(conn, defaultSettings(), metrics(), 0.05);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain('top-10 holders bezitten 40.0%');
  });

  it('keurt af als de bonding curve voltooid is of ontbreekt (alleen-bonding)', async () => {
    const done = await preBuyChecks(fakeConn({ curve: curveBuf({ complete: true }) }).conn, defaultSettings(), metrics(), 0.05);
    expect(done.ok).toBe(false);
    expect(done.reasons[0]).toContain('voltooid');
    const missing = await preBuyChecks(fakeConn({ curve: null }).conn, defaultSettings(), metrics(), 0.05);
    expect(missing.ok).toBe(false);
    expect(missing.reasons[0]).toContain('geen pump.fun bonding curve');
  });

  it('keurt mayhem-mode-tokens af', async () => {
    const r = await preBuyChecks(fakeConn({ curve: curveBuf({ mayhem: true }) }).conn, defaultSettings(), metrics(), 0.05);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['mayhem mode']);
  });

  it('keurt af als de quote sterk afwijkt van de on-chain prijs (BANDS-scenario)', async () => {
    // Quote geeft 8,7x te veel tokens (prijs 8,7x te laag)
    quoteState.buyPriceFactor = 1 / 8.7;
    const r = await preBuyChecks(fakeConn({}).conn, defaultSettings(), metrics(), 0.05);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/quote wijkt -8\d\.\d% af/);
  });

  it('keurt af als de prijs sinds de evaluatie sterk veranderd is', async () => {
    const r = await preBuyChecks(fakeConn({}).conn, defaultSettings(), metrics({ priceSol: 1.5e-8 }), 0.05);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('veranderd sinds evaluatie');
  });

  it('keurt af als de maker te veel bezit', async () => {
    const r = await preBuyChecks(fakeConn({ creatorRaw: 80_000_000_000_000n }).conn, defaultSettings(), metrics(), 0.05, CREATOR.toBase58());
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain('maker bezit 8.0%');
  });

  it('gebruikt de creator uit het curve-account als de feed hem niet gaf', async () => {
    const r = await preBuyChecks(fakeConn({ creatorRaw: 80_000_000_000_000n }).conn, defaultSettings(), metrics(), 0.05);
    expect(r.reasons[0]).toContain('maker bezit');
  });
});

describe('top10FromAccounts', () => {
  it('sluit het opgegeven account uit en telt maximaal 10 holders', () => {
    const accs = [{ address: 'CURVE', amount: '700' }, ...Array.from({ length: 12 }, (_, i) => ({ address: `H${i}`, amount: '10' }))];
    expect(top10FromAccounts(accs, 1000n, 'CURVE')).toBeCloseTo(10, 6);
    // Zonder uitsluitadres (graduated) valt het grootste account (pool) weg
    expect(top10FromAccounts(accs, 1000n, null)).toBeCloseTo(10, 6);
  });

  it('sanity: curve-prijs van de testbuffer is 3e-8', async () => {
    const { decodeCurve } = await import('../src/market/bondingCurve.js');
    expect(curvePriceSol(decodeCurve(curveBuf())!)).toBeCloseTo(3e-8, 15);
  });
});
