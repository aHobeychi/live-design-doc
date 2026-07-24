import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AGENT_LABELS, AGENT_NAMES, installSkill, parseAgentSelection, type AgentName } from './skills.js';

interface Config {
  version: 1;
  agents: AgentName[];
  configuredAt: string;
}

export function configPath(): string {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(root, 'live-design-doc', 'config.json');
}

export function loadConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as Config;
  } catch {
    return null;
  }
}

export function saveConfig(agents: AgentName[]): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, agents, configuredAt: new Date().toISOString() }, null, 2) + '\n');
}

/**
 * First-launch onboarding: offer to install the agent skill. Runs at most
 * once (a config file marks it done) and ONLY on an interactive terminal —
 * an agent driving the CLI must never be blocked on a prompt.
 */
export async function maybeFirstRunSetup(): Promise<void> {
  if (loadConfig()) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) return;

  const out = process.stderr;
  out.write('\nWelcome to live-design-doc — first-time setup.\n');
  out.write('Install the livedoc skill so your coding agents know how to drive it?\n\n');
  AGENT_NAMES.forEach((a, i) => out.write(`  ${i + 1}. ${AGENT_LABELS[a]}\n`));
  out.write('\n');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let agents: AgentName[] = [];
  try {
    const answer = await rl.question('Agents to set up (e.g. "1,3", "all", empty to skip): ');
    agents = parseAgentSelection(answer);
  } catch {
    // Ctrl+D / Ctrl+C at the prompt means skip, not crash.
  } finally {
    rl.close();
  }

  for (const agent of agents) {
    const target = installSkill(agent, 'personal');
    out.write(`  installed for ${AGENT_LABELS[agent]}: ${target}\n`);
  }
  if (agents.length === 0) {
    out.write('  skipped — run `live-design-doc init` any time to set an agent up.\n');
  }
  saveConfig(agents);
  out.write('\n');
}
