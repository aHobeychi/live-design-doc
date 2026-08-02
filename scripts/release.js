// Derives the next semver version from conventional-commit subjects since the last
// release tag, and writes it into package.json. Run by .github/workflows/release.yml
// before `npm publish`; see the commit-message rule in CLAUDE.md.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const SEPARATOR = '\n==commit==\n';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function lastTag() {
  try {
    return git(['describe', '--tags', '--abbrev=0']);
  } catch {
    return null; // no tags yet -- consider the whole history
  }
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

const tag = lastTag();
const range = tag ? `${tag}..HEAD` : 'HEAD';
const log = git(['log', range, `--format=%s%n%b${SEPARATOR}`]);
const commits = log.split(SEPARATOR).map((s) => s.trim()).filter(Boolean);

let bump = null;
for (const commit of commits) {
  const subject = commit.split('\n')[0];
  const breaking = /BREAKING CHANGE:/.test(commit) || /^\w+(\([^)]*\))?!:/.test(subject);
  if (breaking) {
    bump = 'major';
    break;
  }
  if (/^feat(\([^)]*\))?:/.test(subject)) {
    bump = 'minor';
  } else if (/^(fix|perf)(\([^)]*\))?:/.test(subject) && bump !== 'minor') {
    bump = 'patch';
  }
}

if (!bump) {
  console.log(`release: no feat/fix/perf/breaking commits since ${tag ?? '(repo start)'}, skipping`);
  setOutput('bump', 'none');
  process.exit(0);
}

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const next =
  bump === 'major' ? `${major + 1}.0.0`
  : bump === 'minor' ? `${major}.${minor + 1}.0`
  : `${major}.${minor}.${patch + 1}`;

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`release: ${tag ?? '(repo start)'} -> v${next} (${bump})`);
setOutput('bump', bump);
setOutput('version', next);
