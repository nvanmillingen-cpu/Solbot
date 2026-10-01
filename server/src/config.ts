import 'dotenv/config';
import path from 'node:path';

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(v.toLowerCase());
}

const rpcUrl = process.env.RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';

export const config = {
  privateKey: process.env.PRIVATE_KEY?.trim() || '',
  rpcUrl,
  rpcWsUrl: process.env.RPC_WS_URL?.trim() || undefined,
  liveTradingEnabled: bool(process.env.LIVE_TRADING_ENABLED),
  jupiterApiUrl: (process.env.JUPITER_API_URL?.trim() || 'https://lite-api.jup.ag').replace(/\/$/, ''),
  jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || '',
  pumpPortalApiKey: process.env.PUMPPORTAL_API_KEY?.trim() || '',
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  dbPath: path.resolve(process.env.DB_PATH?.trim() || './data/solbot.db'),
  logDir: path.resolve(process.env.LOG_DIR?.trim() || './logs'),
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
};

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** Alle pump.fun tokens hebben een vaste supply van 1 miljard. */
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;
export const PUMP_TOKEN_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;
