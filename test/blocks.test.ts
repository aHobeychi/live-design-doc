import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBlocks } from '../src/doc/blocks.js';
import { parseDocument } from '../src/doc/ids.js';

test('headings, paragraphs, and blank-line separation', () => {
  const blocks = parseDocument('# Title\n\nFirst para\nstill first.\n\nSecond para.\n');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'paragraph', 'paragraph']
  );
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].text, 'First para\nstill first.');
});

test('code fences are atomic — never split on blank lines or markers inside', () => {
  const md = '```js\nconst a = 1;\n\n# not a heading\n- not a list\n```\nafter';
  const blocks = splitBlocks(md);
  assert.equal(blocks[0].type, 'code');
  assert.ok(blocks[0].text.includes('# not a heading'));
  assert.equal(blocks[1].type, 'paragraph');
  assert.equal(blocks[1].text, 'after');
});

test('each top-level list item is its own block; nested items fold in', () => {
  const md = '- one\n- two\n  - nested under two\n- three\n\npara';
  const blocks = splitBlocks(md);
  const items = blocks.filter((b) => b.type === 'listItem');
  assert.equal(items.length, 3);
  assert.ok(items[1].text.includes('nested under two'));
  assert.ok(items.every((b) => b.listGroup === items[0].listGroup));
});

test('a paragraph breaks the list group', () => {
  const blocks = splitBlocks('- a\n\npara\n\n- b');
  const items = blocks.filter((b) => b.type === 'listItem');
  assert.notEqual(items[0].listGroup, items[1].listGroup);
});

test('checkbox detection on task items', () => {
  const blocks = splitBlocks('- [ ] todo thing\n- [x] done thing\n- plain');
  assert.equal(blocks[0].checkbox, 'todo');
  assert.equal(blocks[1].checkbox, 'done');
  assert.equal(blocks[2].checkbox, undefined);
});

test('tables and blockquotes collect greedily', () => {
  const blocks = splitBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> quoted\n> more');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['table', 'blockquote']
  );
});

test('explicit {#id} is used and stripped from the text', () => {
  const blocks = parseDocument('- [ ] Add limiter {#t-limiter}');
  assert.equal(blocks[0].id, 't-limiter');
  assert.ok(!blocks[0].text.includes('{#'));
  assert.equal(blocks[0].checkbox, 'todo');
});

test('content-derived ids are stable when text is unchanged, differ when not', () => {
  const [a1] = parseDocument('Same paragraph text.');
  const [a2] = parseDocument('Same paragraph text.');
  const [b] = parseDocument('Different paragraph text.');
  assert.equal(a1.id, a2.id);
  assert.match(a1.id, /^b-[0-9a-f]{8}$/);
  assert.notEqual(a1.id, b.id);
});

test('duplicate content gets deterministic suffixed ids', () => {
  const blocks = parseDocument('same\n\nsame\n\nsame');
  assert.equal(new Set(blocks.map((b) => b.id)).size, 3);
  assert.equal(blocks[1].id, blocks[0].id + '-2');
  assert.equal(blocks[2].id, blocks[0].id + '-3');
});

test('a {#id} inside a code fence is code, not an id', () => {
  const [block] = parseDocument('```\nx {#not-an-id}\n```');
  assert.equal(block.type, 'code');
  assert.match(block.id, /^b-/);
  assert.ok(block.text.includes('{#not-an-id}'));
});
