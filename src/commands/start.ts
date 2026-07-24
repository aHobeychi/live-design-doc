import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, emit, fail, LIVEDOC_DIR, probe, readSession } from './api.js';

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* URL is printed either way */
  }
}

interface BootLine {
  port: number;
  url: string;
}

function spawnDaemon(file: string, dir: string): Promise<BootLine> {
  const daemonPath = fileURLToPath(new URL('../daemon/main.js', import.meta.url));
  const child = spawn(process.execPath, [daemonPath, '--file', file, '--dir', dir], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise<BootLine>((resolveBoot, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      reject(new Error(`daemon did not report a port within 5s${err ? `\n${err}` : ''}`));
    }, 5000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const nl = out.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          resolveBoot(JSON.parse(out.slice(0, nl)) as BootLine);
        } catch {
          reject(new Error(`unexpected daemon output: ${out.slice(0, nl)}`));
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited with code ${code}${err ? `\n${err}` : ''}`));
    });
  }).finally(() => {
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  });
}

export async function start(args: string[]): Promise<void> {
  const noOpen = args.includes('--no-open');
  const fileArg = args.find((a) => !a.startsWith('--'));
  if (!fileArg) fail('usage: livedoc start <plan.md> [--no-open]');
  const file = resolve(fileArg);
  const dir = join(process.cwd(), LIVEDOC_DIR);

  // Idempotent start (design §12): a live session is reused and reloaded.
  const existing = readSession();
  if (existing && (await probe(existing))) {
    if (existsSync(file)) {
      try {
        await api('POST', '/api/reload');
      } catch {
        /* empty file: daemon stays in its current phase */
      }
    }
    console.error(`livedoc: reusing session at ${existing.url}`);
    emit({ status: 'ok', url: existing.url, port: existing.port, reused: true });
    return;
  }

  const boot = await spawnDaemon(file, dir);
  if (!noOpen) openBrowser(boot.url);
  console.error(`livedoc: reviewing ${fileArg} at ${boot.url}`);
  emit({ status: 'ok', url: boot.url, port: boot.port, reused: false });
}
