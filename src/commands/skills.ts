import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type AgentName = 'claude' | 'copilot' | 'codex';
export type Scope = 'project' | 'personal';

export const AGENT_NAMES: AgentName[] = ['claude', 'copilot', 'codex'];

export const AGENT_LABELS: Record<AgentName, string> = {
  claude: 'Claude Code',
  copilot: 'GitHub Copilot CLI',
  codex: 'OpenAI Codex CLI',
};

/** Skill directories per agent and scope (design §11, extended with Codex). */
export function skillDir(
  agent: AgentName,
  scope: Scope,
  base: { home?: string; cwd?: string } = {}
): string {
  const home = base.home ?? homedir();
  const cwd = base.cwd ?? process.cwd();
  const roots: Record<AgentName, Record<Scope, string>> = {
    claude: { project: join(cwd, '.claude', 'skills'), personal: join(home, '.claude', 'skills') },
    copilot: { project: join(cwd, '.github', 'skills'), personal: join(home, '.copilot', 'skills') },
    codex: { project: join(cwd, '.codex', 'skills'), personal: join(home, '.codex', 'skills') },
  };
  return join(roots[agent][scope], 'livedoc');
}

export function skillSourcePath(): string {
  return fileURLToPath(new URL('../../../skill/SKILL.md', import.meta.url));
}

/** Copy SKILL.md into the agent's skill directory; returns the installed path. */
export function installSkill(
  agent: AgentName,
  scope: Scope,
  base: { home?: string; cwd?: string } = {}
): string {
  const dir = skillDir(agent, scope, base);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'SKILL.md');
  copyFileSync(skillSourcePath(), target);
  return target;
}

/**
 * Parse a first-run selection like "1,3", "claude codex", or "all" into agent
 * names. Unknown tokens are ignored; empty input means skip.
 */
export function parseAgentSelection(input: string): AgentName[] {
  const tokens = input
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.includes('all')) return [...AGENT_NAMES];
  const picked = new Set<AgentName>();
  for (const t of tokens) {
    const byIndex = AGENT_NAMES[Number(t) - 1];
    if (/^\d+$/.test(t) && byIndex) picked.add(byIndex);
    else if ((AGENT_NAMES as string[]).includes(t)) picked.add(t as AgentName);
  }
  return [...picked];
}
