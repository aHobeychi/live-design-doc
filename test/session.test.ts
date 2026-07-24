import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition } from '../src/daemon/session.js';

test('the lifecycle path: clarify → draft → review → approve → execute → done', () => {
  assert.ok(canTransition('drafting', 'clarifying')); // ask on an empty plan (regression)
  assert.ok(canTransition('clarifying', 'drafting')); // answers submitted
  assert.ok(canTransition('clarifying', 'review')); // push = implicit skip
  assert.ok(canTransition('drafting', 'review'));
  assert.ok(canTransition('review', 'review')); // every subsequent push
  assert.ok(canTransition('review', 'approved'));
  assert.ok(canTransition('approved', 'executing'));
  assert.ok(canTransition('executing', 'review')); // mid-build revision → fresh approval
  assert.ok(canTransition('executing', 'done'));
});

test('illegal shortcuts are refused', () => {
  assert.ok(!canTransition('drafting', 'approved'));
  assert.ok(!canTransition('clarifying', 'executing'));
  assert.ok(!canTransition('review', 'executing'));
  assert.ok(!canTransition('done', 'approved'));
});
