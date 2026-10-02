import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../logger.js';

let child: ChildProcess | null = null;

/**
 * Windows: vraagt het systeem om niet in slaapstand te gaan zolang de bot draait (zoals
 * een videospeler doet; er wordt geen instelling gewijzigd). Een klein PowerShell-proces
 * roept SetThreadExecutionState aan en stopt vanzelf zodra de bot stopt.
 * Let op: het dichtklappen van een laptop of handmatig "Slaapstand" kiezen houdt dit niet tegen.
 */
export function setKeepAwake(on: boolean) {
  if (process.platform !== 'win32') return;
  if (!on) {
    if (child) {
      child.kill();
      child = null;
      logger.info('slaapstand-blokkering uit');
    }
    return;
  }
  if (child) return;
  const script = [
    "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    '$k = Add-Type -MemberDefinition $sig -Name Pwr -Namespace Solbot -PassThru',
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    '[void]$k::SetThreadExecutionState([uint32]2147483649)',
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`,
  ].join('; ');
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => {
      logger.warn({ err: String(e) }, 'slaapstand blokkeren mislukt');
      child = null;
    });
    child.on('exit', () => {
      child = null;
    });
    logger.info('slaapstand geblokkeerd zolang de bot draait (laptop dichtklappen stopt de bot nog wel)');
  } catch (e) {
    logger.warn({ err: String(e) }, 'slaapstand blokkeren mislukt');
  }
}
