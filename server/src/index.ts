import { Connection } from '@solana/web3.js';
import { startServer } from './api/server.js';
import { config } from './config.js';
import { Bot } from './core/bot.js';
import { PositionManager } from './core/positions.js';
import { TokenTracker } from './core/tracker.js';
import { openDb } from './db.js';
import { JupiterBuilder, LiveExecutor, PumpPortalBuilder } from './executor/live.js';
import { PaperExecutor } from './executor/paper.js';
import type { Executor } from './executor/types.js';
import { PumpPortalFeed } from './feed/pumpportal.js';
import { logFile, logger } from './logger.js';
import { lastPrice } from './core/metrics.js';
import { solUsd } from './market/solPrice.js';
import { SettingsStore } from './settings.js';
import { loadWallet } from './wallet.js';

async function main() {
  logger.info({ logFile, db: config.dbPath, rpc: config.rpcUrl.replace(/api-key=[^&]+/, 'api-key=***') }, 'Solbot start');

  const db = openDb(config.dbPath);
  const store = new SettingsStore(db);
  const wallet = loadWallet();
  if (wallet) logger.info({ address: wallet.publicKey.toBase58() }, 'wallet geladen');
  else logger.warn('geen wallet: alleen paper mode');

  // Veiligheid: live mode alleen als dat expliciet in .env is toegestaan
  if (!store.get().general.paperMode && (!config.liveTradingEnabled || !wallet)) {
    store.update({ general: { paperMode: true } });
    logger.warn('live mode niet toegestaan (LIVE_TRADING_ENABLED/PRIVATE_KEY); terug naar paper mode');
  }

  const conn = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: config.rpcWsUrl, disableRetryOnRateLimit: false });
  const feed = new PumpPortalFeed();
  const tracker = new TokenTracker(conn, feed, () => store.get());

  const paper = new PaperExecutor((mint) => {
    const t = tracker.tokens.get(mint);
    return { priceSol: t ? lastPrice(t)?.priceSol ?? null : null, curve: t?.curve, graduated: t?.graduated ?? false };
  });
  const live: Executor | null = wallet
    ? new LiveExecutor(
        conn,
        wallet,
        () => {
          const jup = new JupiterBuilder();
          const pp = new PumpPortalBuilder();
          return store.get().general.executor === 'pumpportal' ? [pp, jup] : [jup, pp];
        },
        () => store.get().general.maxTxRetries,
      )
    : null;
  const executorFor = (mode: 'paper' | 'live') => (mode === 'paper' ? paper : live);

  const positions = new PositionManager(db, conn, tracker, () => store.get(), executorFor);
  const bot = new Bot(db, conn, store, tracker, positions, wallet, executorFor);

  // Instellingen gelden direct: timers met nieuwe intervallen herstarten
  store.onChange(() => {
    tracker.restart();
    positions.start();
  });

  await solUsd();
  feed.start();
  tracker.start();
  positions.start();
  bot.startLoop();
  await startServer({ bot, store, positions, tracker, feed, wallet });

  const shutdown = (sig: string) => {
    logger.info({ sig }, 'afsluiten');
    feed.stop();
    tracker.stop();
    positions.stop();
    bot.stopLoop();
    db.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
}

main().catch((e) => {
  logger.fatal({ err: String(e) }, 'opstarten mislukt');
  process.exit(1);
});
