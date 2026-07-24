import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderInline, renderBlock } from '../src/doc/render.js';
import { parseDocument } from '../src/doc/ids.js';

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<script>"a" & b</script>'), '&lt;script&gt;&quot;a&quot; &amp; b&lt;/script&gt;');
});

test('inline: code spans, bold, italic, links', () => {
  assert.equal(renderInline('run `npm test` now'), 'run <code>npm test</code> now');
  assert.equal(renderInline('**bold** and *ital*'), '<strong>bold</strong> and <em>ital</em>');
  assert.equal(
    renderInline('[docs](https://example.com/x)'),
    '<a href="https://example.com/x" target="_blank" rel="noopener">docs</a>'
  );
});

test('inline: formatting is not applied inside code spans', () => {
  assert.equal(renderInline('use `a * b * c` here'), 'use <code>a * b * c</code> here');
});

test('regression: literal digits are not confused with code-span placeholders', () => {
  // " 0 " in prose must survive next to a code span (placeholder index 0).
  assert.equal(renderInline('`x` gives 0 results'), '<code>x</code> gives 0 results');
  assert.equal(renderInline('allow 100 req/min via `limiter`'), 'allow 100 req/min via <code>limiter</code>');
});

test('unsafe link schemes are stripped', () => {
  const out = renderInline('[click](javascript:alert(1))');
  assert.ok(out.includes('href="#"'), out);
});

test('block html is escaped — a hostile plan cannot script the review tab', () => {
  const [block] = parseDocument('<img src=x onerror=alert(1)> text');
  const html = renderBlock(block);
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img'), html);
});

test('heading levels map to h1–h6 and carry data-id', () => {
  const blocks = parseDocument('# One\n\n### Three {#h-three}');
  assert.match(renderBlock(blocks[0]), /^<h1 [^>]*class="block heading"/);
  const h3 = renderBlock(blocks[1]);
  assert.match(h3, /^<h3 /);
  assert.ok(h3.includes('data-id="h-three"'));
  assert.ok(!h3.includes('{#'));
});

test('table renders header and body rows, skipping the separator', () => {
  const [block] = parseDocument('| Col | Val |\n| --- | --- |\n| a | 1 |');
  const html = renderBlock(block);
  assert.ok(html.includes('<th>Col</th>'));
  assert.ok(html.includes('<td>a</td>'));
  assert.ok(!html.includes('---'));
});

test('code fence renders its body without the fence lines', () => {
  const [block] = parseDocument('```js\nconst a = 1;\n```');
  const html = renderBlock(block);
  assert.ok(html.includes('const a = 1;'));
  assert.ok(!html.includes('```'));
});

test('checkbox list item renders a tick with its state', () => {
  const blocks = parseDocument('- [ ] pending {#t-a}\n- [x] finished {#t-b}');
  const todo = renderBlock(blocks[0]);
  const done = renderBlock(blocks[1]);
  assert.ok(todo.includes('data-state="todo"'));
  assert.ok(done.includes('data-state="done"'));
  assert.ok(!todo.includes('[ ]'));
});

test('blockquote strips the > markers', () => {
  const [block] = parseDocument('> quoted line\n> second line');
  const html = renderBlock(block);
  assert.ok(html.startsWith('<blockquote'));
  assert.ok(!html.includes('&gt; quoted'));
  assert.ok(html.includes('quoted line second line'));
});
