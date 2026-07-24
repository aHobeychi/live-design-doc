import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diceBigram, reanchor } from '../src/doc/anchor.js';
import { parseDocument } from '../src/doc/ids.js';
import type { Note } from '../src/types.js';

function noteOn(blockId: string, quote: string, blockText: string, ctx: Partial<Note> = {}): Note {
  return {
    id: 'n-test',
    state: 'sent',
    intent: 'change',
    body: 'x',
    quote,
    contextBefore: '',
    contextAfter: '',
    blockId,
    blockTextAtCreation: blockText,
    createdAgainstRevision: 1,
    resolved: { blockId, fidelity: 'exact' },
    seenByAgent: false,
    ...ctx,
  };
}

test('tier 1: quote still in the original block → exact', () => {
  const blocks = parseDocument('The limiter covers 100 req/min per key. {#t}');
  const note = noteOn('t', '100 req/min', blocks[0].text);
  assert.deepEqual(reanchor(note, blocks), { blockId: 't', fidelity: 'exact' });
});

test('block-level note (empty quote): surviving block id → exact', () => {
  const blocks = parseDocument('```mockup:html\n<button>Save</button>\n```\n\nProse after.');
  const note = noteOn(blocks[0].id, '', blocks[0].text);
  assert.deepEqual(reanchor(note, blocks), { blockId: blocks[0].id, fidelity: 'exact' });
});

test('block-level note: edited mockup re-anchors by similarity, not exact', () => {
  const before = parseDocument('```mockup:html\n<button>Save changes now</button>\n<p>Settings form panel</p>\n```');
  const after = parseDocument('```mockup:html\n<button>Save changes</button>\n<p>Settings form panel</p>\n```');
  const note = noteOn(before[0].id, '', before[0].text);
  const r = reanchor(note, after);
  assert.equal(r.fidelity, 'approximate');
  assert.equal(r.blockId, after[0].id);
});

test('tier 2: quote plus context found in another block → moved', () => {
  const original = 'backed by Redis, 100 req/min per key';
  const blocks = parseDocument(`Intro paragraph here.\n\nNow ${original} as before.`);
  const note = noteOn('gone-id', '100 req/min', original, {
    contextBefore: 'backed by Redis, ',
    contextAfter: ' per key',
  });
  assert.deepEqual(reanchor(note, blocks), {
    blockId: blocks[1].id,
    fidelity: 'moved',
  });
});

test('tier 3: bare quote found in exactly one other block → moved', () => {
  const blocks = parseDocument('Alpha text.\n\nHolds the magic-token value.');
  const note = noteOn('gone-id', 'magic-token', 'old block that had magic-token in it');
  const r = reanchor(note, blocks);
  assert.equal(r.fidelity, 'moved');
  assert.equal(r.blockId, blocks[1].id);
});

test('trap: an ambiguous quote must NOT resolve as moved', () => {
  const blocks = parseDocument('First has target phrase here.\n\nSecond has target phrase here too, differently.');
  const note = noteOn('gone-id', 'target phrase', 'a vanished block about target phrase');
  const r = reanchor(note, blocks);
  assert.notEqual(r.fidelity, 'moved');
  assert.notEqual(r.fidelity, 'exact');
});

test('tier 4: reworded block found by bigram similarity → approximate', () => {
  const originalText = 'Add a RateLimiter class backed by Redis with a hundred requests per minute per key';
  const blocks = parseDocument(
    'Unrelated intro.\n\nAdd a RateLimiter class backed by Memcached with a hundred requests per minute per key'
  );
  const note = noteOn('gone-id', 'backed by Redis', originalText);
  const r = reanchor(note, blocks);
  assert.equal(r.fidelity, 'approximate');
  assert.equal(r.blockId, blocks[1].id);
});

test('trap: a near-miss must orphan, not approximate', () => {
  const blocks = parseDocument('Entirely different topic about deployment pipelines and caching layers.');
  const note = noteOn('gone-id', 'rate limiter', 'Add a RateLimiter backed by Redis per key');
  assert.deepEqual(reanchor(note, blocks), { blockId: null, fidelity: 'orphan' });
});

test('diceBigram basics', () => {
  assert.equal(diceBigram('a b c', 'a b c'), 1);
  assert.equal(diceBigram('a b c', 'x y z'), 0);
  const mid = diceBigram('add rate limiter to search', 'add rate limiter to reads');
  assert.ok(mid > 0.4 && mid < 1, String(mid));
});
