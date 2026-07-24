// The zero-runtime-dependency principle (design §9.3) as a gate, not a convention.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});
if (deps.length > 0) {
  console.error(`livedoc must have zero runtime dependencies; found: ${deps.join(', ')}`);
  process.exit(1);
}
console.log('no-deps-check: ok');
