import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { emit, fail } from './api.js';
import { AGENT_NAMES, installSkill, skillSourcePath, type AgentName, type Scope } from './skills.js';
import { loadConfig, saveConfig } from './setup.js';

async function prompt(question: string, choices: string[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = (await rl.question(`${question} (${choices.join('/')}) `)).trim().toLowerCase();
      if (choices.includes(answer)) return answer;
    }
  } finally {
    rl.close();
  }
}

export async function init(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const agent = (flag('agent') ?? (await prompt('Which agent?', [...AGENT_NAMES]))) as AgentName;
  const scope = (flag('scope') ?? (await prompt('Which scope?', ['project', 'personal']))) as Scope;
  if (!AGENT_NAMES.includes(agent)) fail(`unknown agent "${agent}" (${AGENT_NAMES.join(', ')})`);
  if (!['project', 'personal'].includes(scope)) fail(`unknown scope "${scope}"`);

  readFileSync(skillSourcePath()); // fail early with a clear path if the package is broken
  const target = installSkill(agent, scope);
  // Explicit init counts as setup: never show the first-run prompt afterwards.
  const already = loadConfig()?.agents ?? [];
  saveConfig([...new Set([...already, agent])]);
  console.error(`livedoc: installed skill to ${target}`);
  emit({ status: 'ok', installed: target });
}
