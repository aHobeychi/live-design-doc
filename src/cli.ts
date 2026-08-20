#!/usr/bin/env node
import { fail } from './commands/api.js';
import { start } from './commands/start.js';
import { wait } from './commands/wait.js';
import { ask, progress, push, stop, verify } from './commands/misc.js';
import { init } from './commands/init.js';
import { maybeFirstRunSetup } from './commands/setup.js';
import { createRequire } from 'node:module';

// Read the shipped package.json so `--version` can't drift from the released version.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

const HELP = `live-design-doc (livedoc) — live plan review between a coding agent and a human

usage:
  livedoc start <plan.md> [--no-open]   start (or reattach to) the review session
  livedoc ask <questions.json>          post clarifying questions (before first draft only)
  livedoc wait [--timeout <sec>]        block until feedback/approval/answers or timeout
  livedoc push                          reload the plan file as a new revision
  livedoc progress <block-id> [done] --did "…" [--files a.ts,b.ts]
                                        tick a task with evidence of what was done
  livedoc verify                        plan-vs-reality check; exits 1 if tasks are unticked
  livedoc stop                          shut the daemon down
  livedoc init [--agent claude|copilot|codex] [--scope project|personal]
                                        install the agent skill

Results are single-line JSON on stdout; human messages go to stderr.`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  // First interactive launch offers agent setup; `init` is already setup.
  if (cmd !== 'init') await maybeFirstRunSetup();
  switch (cmd) {
    case 'start':
      return start(rest);
    case 'ask':
      return ask(rest);
    case 'wait':
      return wait(rest);
    case 'push':
      return push();
    case 'progress':
      return progress(rest);
    case 'verify':
      return verify();
    case 'stop':
      return stop();
    case 'init':
      return init(rest);
    case '--version':
    case 'version':
      return void console.log(version);
    case 'help':
    case '--help':
    case undefined:
      return void console.log(HELP);
    default:
      fail(`unknown command "${cmd}" — run \`livedoc help\``);
  }
}

main().catch((e: Error) => fail(e.message));
