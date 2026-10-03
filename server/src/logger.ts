import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { config } from './config.js';

fs.mkdirSync(config.logDir, { recursive: true });

export interface LogEntry {
  time: number;
  level: string;
  msg: string;
}

const LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const MAX_RECENT = 300;
const recent: LogEntry[] = [];

/** Houdt de laatste logregels in geheugen bij voor het dashboard. */
const memoryStream = {
  write(line: string) {
    try {
      const o = JSON.parse(line);
      const extra = Object.entries(o)
        .filter(([k]) => !['level', 'time', 'tijd', 'msg', 'pid', 'hostname'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      recent.push({ time: o.time, level: LEVELS[o.level] ?? String(o.level), msg: extra ? `${o.msg} ${extra}` : o.msg });
      if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
    } catch {
      /* negeren */
    }
  },
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Lokale datum en tijd als 2026-10-02_14-35-07 (sorteert goed en is geldig in bestandsnamen). */
export function stamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Elke opstart een eigen run: eigen logbestand en run-id (ook opgeslagen bij elke trade). */
export const runStartedAt = Date.now();
export const runId = stamp(new Date(runStartedAt));
export const logFile = path.join(config.logDir, `solbot_${runId}.log`);

export const logger = pino(
  {
    level: config.logLevel,
    base: undefined,
    // Leesbare lokale tijd naast de epoch-tijd, voor analyse achteraf
    timestamp: () => {
      const d = new Date();
      return `,"time":${d.getTime()},"tijd":"${stamp(d).replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')}.${String(d.getMilliseconds()).padStart(3, '0')}"`;
    },
  },
  pino.multistream([
    { level: 'debug', stream: pino.destination({ dest: logFile, sync: false, mkdir: true }) },
    { level: config.logLevel as pino.Level, stream: process.stdout },
    { level: 'info', stream: memoryStream },
  ]),
);

export function recentLogs(limit = 100): LogEntry[] {
  return recent.slice(-limit);
}

const lastLogged = new Map<string, { at: number; suppressed: number }>();

/**
 * Rate-limiting voor herhalende fouten: geeft true als er gelogd mag worden (max. één keer
 * per `intervalMs` per sleutel). `suppressed` = aantal overgeslagen meldingen sinds de vorige.
 */
export function shouldLog(key: string, intervalMs = 60_000, now = Date.now()): { ok: boolean; suppressed: number } {
  const e = lastLogged.get(key);
  if (e && now - e.at < intervalMs) {
    e.suppressed++;
    return { ok: false, suppressed: 0 };
  }
  const suppressed = e?.suppressed ?? 0;
  lastLogged.set(key, { at: now, suppressed: 0 });
  return { ok: true, suppressed };
}

/**
 * "Reset logs": verwijdert alle logbestanden van de bot in de logmap. Het bestand van de
 * lopende run staat nog open en wordt daarom leeggemaakt in plaats van verwijderd.
 * Ook de logregels in het dashboard worden gewist.
 */
export function resetLogs(): { deleted: number; failed: string[] } {
  let deleted = 0;
  const failed: string[] = [];
  for (const name of fs.readdirSync(config.logDir)) {
    if (!/^solbot.*\.log$/.test(name)) continue;
    const file = path.join(config.logDir, name);
    try {
      if (file === logFile) fs.truncateSync(file, 0);
      else fs.unlinkSync(file);
      deleted++;
    } catch {
      failed.push(name);
    }
  }
  recent.splice(0, recent.length);
  return { deleted, failed };
}
