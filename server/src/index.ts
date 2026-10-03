import { Connection } from '@solana/web3.js';
import { startServer } from './api/server.js';
import { config } from './config.js';
import { Bot } from './core/bot.js';
import { PositionManager } from './core/positions.js';
import { TokenTracker } from './core/tracker.js';
import { kvGet, kvSet, openDb } from './db.js';
import { JupiterBuilder, LiveExecutor, PumpPortalBuilder } from './executor/live.js';
import { PaperExecutor } from './executor/paper.js';
import type { Executor } from './executor/types.js';
import { PumpPortalFeed } from './feed/pumpportal.js';
import { logFile, logger, runId, stamp } from './logger.js';
import { lastPrice } from './core/metrics.js';
import { solUsd } from './market/solPrice.js';
import { fetchCurves } from './market/bondingCurve.js';
import { probeTop10Support } from './core/safety.js';
import { SkipLog } from './core/skipped.js';
import { diffSettings, SettingsStore } from './settings.js';
import { setKeepAwake } from './util/keepAwake.js';
import { loadWallet } from './wallet.js';

async function main() {
  logger.info({ runId, logFile, db: config.dbPath, rpc: config.rpcUrl.replace(/api-key=[^&]+/, 'api-key=***') }, 'Solbot start');

  const db = openDb(config.dbPath);
  // Crashdetectie: is de vorige run netjes afgesloten? Zo niet, dan stond de bewaking stil.
  const lastBeat = Number(kvGet(db, 'heartbeat') ?? 0);
  if (kvGet(db, 'clean_shutdown') === 'false' && lastBeat) {
    const open = (db.prepare("SELECT COUNT(*) AS n FROM positions WHERE status IN ('open','closing')").get() as { n: number }).n;
    logger.error(
      { vorigeRun: kvGet(db, 'run_id'), laatsteHartslag: stamp(new Date(lastBeat)), stilMin: +((Date.now() - lastBeat) / 60_000).toFixed(1), openPosities: open },
      'vorige run is NIET netjes afgesloten (crash, slaapstand of pc uit): posities waren in die tijd onbewaakt',
    );
  }
  kvSet(db, 'clean_shutdown', 'false');
  kvSet(db, 'run_id', runId);
  kvSet(db, 'heartbeat', String(Date.now()));

  const store = new SettingsStore(db);
  logger.info({ config: store.hash() }, 'actieve instellingen (config-hash)');
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

  const paper = new PaperExecutor({
    lastPrice: (mint) => {
      const t = tracker.tokens.get(mint);
      return t ? lastPrice(t)?.priceSol ?? null : null;
    },
    freshCurve: async (mint) => (await fetchCurves(conn, [mint])).get(mint),
  }, () => store.get().paper);
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
  const skipLog = new SkipLog(db, tracker, () => store.get().tracker.postExitWatchMin, () => store.hash());
  const bot = new Bot(db, conn, store, tracker, positions, wallet, executorFor, skipLog);

  // Instellingen gelden direct: timers met nieuwe intervallen herstarten
  let lastHash = store.hash();
  let lastSettings = store.get();
  store.onChange((s) => {
    tracker.restart();
    positions.start();
    setKeepAwake(s.general.preventSleep);
    const h = store.hash();
    const prevSettings = lastSettings;
    lastSettings = s;
    if (h !== lastHash) {
      // Experimenthygiëne: trades vóór en na deze wijziging niet zomaar vergelijken
      // Precies loggen wat er veranderde, zodat hashes later te vergelijken zijn
      logger.warn({ van: lastHash, naar: h, botActief: bot.running, wijzigingen: diffSettings(prevSettings, s) }, 'instellingen gewijzigd: nieuwe config-hash');
      lastHash = h;
    }
  });
  setKeepAwake(store.get().general.preventSleep);

  await solUsd();
  // Opstarttest: levert deze RPC de top-10-holderdata?
  void probeTop10Support(conn);
  feed.start();
  tracker.start();
  positions.start();
  skipLog.start();
  bot.startLoop();
  await startServer({ bot, store, positions, tracker, feed, wallet, skipLog });

  const shutdown = (sig: string, code = 0) => {
    logger.info({ sig }, 'afsluiten');
    try {
      kvSet(db, 'clean_shutdown', 'true');
    } catch {
      /* db al dicht */
    }
    setKeepAwake(false);
    feed.stop();
    tracker.stop();
    positions.stop();
    skipLog.stop();
    bot.stopLoop();
    db.close();
    setTimeout(() => process.exit(code), 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Windows: venster gesloten
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
  // Onverwachte fout: loggen en met foutcode stoppen, zodat "Solbot starten.bat" de bot herstart
  process.on('uncaughtException', (e) => {
    logger.fatal({ err: String(e), stack: e instanceof Error ? e.stack?.slice(0, 800) : undefined }, 'onverwachte fout, bot stopt');
    shutdown('uncaughtException', 1);
  });
}

main().catch((e) => {
  logger.fatal({ err: String(e) }, 'opstarten mislukt');
  process.exit(1);
});
