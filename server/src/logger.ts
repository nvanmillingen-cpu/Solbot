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
        .filter(([k]) => !['level', 'time', 'msg', 'pid', 'hostname'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      recent.push({ time: o.time, level: LEVELS[o.level] ?? String(o.level), msg: extra ? `${o.msg} ${extra}` : o.msg });
      if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
    } catch {
      /* negeren */
    }
  },
};

const day = new Date().toISOString().slice(0, 10);
export const logFile = path.join(config.logDir, `solbot-${day}.log`);

export const logger = pino(
  { level: config.logLevel, base: undefined },
  pino.multistream([
    { level: 'debug', stream: pino.destination({ dest: logFile, sync: false, mkdir: true }) },
    { level: config.logLevel as pino.Level, stream: process.stdout },
    { level: 'info', stream: memoryStream },
  ]),
);

export function recentLogs(limit = 100): LogEntry[] {
  return recent.slice(-limit);
}
