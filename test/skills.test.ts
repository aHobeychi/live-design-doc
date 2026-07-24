import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { installSkill, parseAgentSelection, skillDir, AGENT_NAMES } from '../src/commands/skills.js';

test('skill directories per agent and scope', () => {
  const base = { home: '/home/u', cwd: '/repo' };
  const expected: [string, string, string][] = [
    ['claude', 'project', '/repo/.claude/skills/livedoc'],
    ['claude', 'personal', '/home/u/.claude/skills/livedoc'],
    ['copilot', 'project', '/repo/.github/skills/livedoc'],
    ['copilot', 'personal', '/home/u/.copilot/skills/livedoc'],
    ['codex', 'project', '/repo/.codex/skills/livedoc'],
    ['codex', 'personal', '/home/u/.codex/skills/livedoc'],
  ];
  for (const [agent, scope, path] of expected) {
    assert.equal(skillDir(agent as never, scope as never, base), path.split('/').join(sep));
  }
});

test('installSkill copies SKILL.md with intact frontmatter', () => {
  const home = mkdtempSync(join(tmpdir(), 'livedoc-skill-'));
  try {
    const target = installSkill('codex', 'personal', { home });
    const content = readFileSync(target, 'utf8');
    assert.ok(content.startsWith('---\nname: livedoc\n'));
    assert.ok(target.endsWith(join('.codex', 'skills', 'livedoc', 'SKILL.md')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('selection parsing: indexes, names, all, junk, empty', () => {
  assert.deepEqual(parseAgentSelection('1,3'), ['claude', 'codex']);
  assert.deepEqual(parseAgentSelection('copilot claude'), ['copilot', 'claude']);
  assert.deepEqual(parseAgentSelection('all'), AGENT_NAMES);
  assert.deepEqual(parseAgentSelection('2, 2, codex'), ['copilot', 'codex']);
  assert.deepEqual(parseAgentSelection('9 gemini !!'), []);
  assert.deepEqual(parseAgentSelection(''), []);
  assert.deepEqual(parseAgentSelection('  '), []);
});
