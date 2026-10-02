import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { config } from '../config.js';
import type { Bot } from '../core/bot.js';
import type { PositionManager } from '../core/positions.js';
import { computeStats, pnlSeries, rangeStart } from '../core/stats.js';
import type { TokenTracker } from '../core/tracker.js';
import type { PumpPortalFeed } from '../feed/pumpportal.js';
import { health } from '../core/health.js';
import { logFile, logger, recentLogs, runId, runStartedAt, stamp } from '../logger.js';
import { solUsdCached } from '../market/solPrice.js';
import { top10Status } from '../core/safety.js';
import type { SettingsStore } from '../settings.js';
import type { Wallet } from '../wallet.js';

interface Deps {
  bot: Bot;
  store: SettingsStore;
  positions: PositionManager;
  tracker: TokenTracker;
  feed: PumpPortalFeed;
  wallet: Wallet | null;
}

export async function startServer(d: Deps) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  await app.register(fastifyWebsocket);

  const modeParam = (q: unknown) => {
    const m = (q as { mode?: string }).mode;
    return m === 'paper' || m === 'live' || m === 'all' ? m : d.bot.mode;
  };

  function state() {
    const s = d.store.get();
    const closedAll = d.positions.closed({ mode: d.bot.mode });
    const hash = d.store.hash();
    return {
      now: Date.now(),
      running: d.bot.running,
      runningSince: d.bot.startedAt,
      run: { id: runId, startedAt: runStartedAt, logFile },
      config: { hash, trades: d.positions.countWithConfig(hash, d.bot.mode) },
      health: health.view(),
      mode: d.bot.mode,
      liveTradingEnabled: config.liveTradingEnabled,
      wallet: d.wallet ? { address: d.wallet.publicKey.toBase58(), sol: d.bot.walletSol } : null,
      solUsd: solUsdCached(),
      feed: {
        connected: d.feed.connected,
        tradesAvailable: d.feed.tradesAvailable,
        lastMessageAt: d.feed.lastMessageAt,
        lastNewTokenAt: d.feed.lastNewTokenAt,
        rpcFallbackActive: d.tracker.rpcFeed.active,
        lastDataAt: d.feed.lastDataAt,
        reconnects: d.feed.reconnects,
      },
      top10: { ...top10Status, required: s.safety.maxTop10Pct.enabled && s.safety.maxTop10Pct.requireData, enabled: s.safety.maxTop10Pct.enabled },
      tracker: { tracked: d.tracker.tokens.size, ...d.tracker.stats },
      blocker: d.bot.running ? d.bot.buyBlocker() : null,
      positions: d.positions.views(),
      stats: computeStats(closedAll.map((r) => ({ closed_at: r.closed_at!, pnl_sol: r.pnl_sol!, pnl_pct: r.pnl_pct! }))),
      maxOpenPositions: s.risk.maxOpenPositions,
      lastEvalAt: d.bot.lastEvalAt,
    };
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'Ongeldige instellingen', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    logger.error({ err: String(err) }, 'API-fout');
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: (err as Error).message });
  });

  app.get('/api/state', async () => state());

  app.get('/api/settings', async () => d.store.get());

  app.put('/api/settings', async (req, reply) => {
    const patch = (req.body ?? {}) as { general?: { paperMode?: boolean } };
    const wantPaper = patch.general?.paperMode;
    if (wantPaper !== undefined && wantPaper !== d.store.get().general.paperMode) {
      if (d.bot.running) return reply.status(400).send({ error: 'Stop de bot voordat je tussen paper en live wisselt.' });
      if (wantPaper === false) {
        if (!config.liveTradingEnabled) return reply.status(400).send({ error: 'Live trading staat uit. Zet LIVE_TRADING_ENABLED=true in .env en herstart.' });
        if (!d.wallet) return reply.status(400).send({ error: 'Geen geldige PRIVATE_KEY in .env.' });
      }
    }
    const next = d.store.update(patch);
    logger.info({ paperMode: next.general.paperMode }, 'instellingen bijgewerkt');
    return next;
  });

  app.post('/api/bot/start', async (_req, reply) => {
    try {
      d.bot.start();
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }
    return { running: true };
  });

  app.post('/api/bot/stop', async () => {
    d.bot.stop();
    return { running: false };
  });

  app.post('/api/positions/sell-all', async () => {
    d.bot.stop();
    await d.positions.sellAll();
    return { ok: true, remaining: d.positions.open().length };
  });

  app.post<{ Params: { id: string } }>('/api/positions/:id/sell', async (req, reply) => {
    const ok = await d.positions.sell(Number(req.params.id), 'MANUAL');
    if (!ok) return reply.status(400).send({ error: 'Verkoop mislukt of positie niet open; zie log. De failsafe probeert opnieuw.' });
    return { ok };
  });

  app.post('/api/stats/reset', async (req) => {
    const mode = modeParam(req.body ?? {});
    const archived = d.positions.archiveClosed(mode);
    logger.info({ mode, archived }, 'statistieken gereset (gesloten trades gearchiveerd)');
    return { ok: true, archived };
  });

  app.get('/api/trades', async (req) => {
    const q = req.query as { limit?: string };
    return d.positions.closed({ mode: modeParam(req.query), limit: Math.min(1000, Number(q.limit ?? 200)) });
  });

  app.get('/api/stats', async (req) => {
    const q = req.query as { range?: string };
    const rows = d.positions.closed({ mode: modeParam(req.query), from: rangeStart(q.range ?? 'all') });
    return computeStats(rows.map((r) => ({ closed_at: r.closed_at!, pnl_sol: r.pnl_sol!, pnl_pct: r.pnl_pct! })));
  });

  app.get('/api/pnl', async (req) => {
    const q = req.query as { range?: string };
    const from = rangeStart(q.range ?? '24h');
    const rows = d.positions.closed({ mode: modeParam(req.query), from });
    return pnlSeries(
      rows.map((r) => ({ closed_at: r.closed_at!, pnl_sol: r.pnl_sol!, pnl_pct: r.pnl_pct! })),
      from,
    );
  });

  /** Alle trades (ook gearchiveerd) als CSV, voor analyse in Excel: MFE/MAE, config-hash en run-id per trade. */
  app.get('/api/trades.csv', async (_req, reply) => {
    const rows = d.positions.allForExport();
    const cols = rows.length ? Object.keys(rows[0]) : ['id'];
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const t = String(v);
      return /[",;\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc((r as Record<string, unknown>)[c])).join(','))].join('\r\n');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="solbot-trades_${stamp()}.csv"`)
      .send('﻿' + csv); // BOM: Excel herkent dan UTF-8
  });

  /** Alle opgeslagen instellingenversies (config-hash → instellingen). */
  app.get('/api/settings/versions', async () => d.store.versions());

  app.get('/api/candidates', async () => d.bot.lastCandidates);
  app.get('/api/logs', async () => ({ file: logFile, lines: recentLogs(300) }));

  app.register(async (f) => {
    f.get('/ws', { websocket: true }, (socket) => {
      const send = () => {
        try {
          socket.send(JSON.stringify({ type: 'state', state: state(), candidates: d.bot.lastCandidates.slice(0, 30), logs: recentLogs(80) }));
        } catch {
          /* client weg */
        }
      };
      send();
      const t = setInterval(send, 1000);
      socket.on('close', () => clearInterval(t));
    });
  });

  // Frontend (na `npm run build`)
  const dist = path.resolve('web/dist');
  if (fs.existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.status(404).send({ error: 'niet gevonden' });
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => 'Dashboard nog niet gebouwd: voer `npm run build` uit (of gebruik `npm run dev`).');
  }

  await app.listen({ host: config.host, port: config.port });
  logger.info(`dashboard: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  return app;
}
