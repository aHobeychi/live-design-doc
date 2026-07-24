import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestions, QUESTION_CAP } from '../src/types.js';

const q = (id: string, kind = 'text', extra: Record<string, unknown> = {}) => ({
  id,
  prompt: `About ${id}?`,
  kind,
  ...extra,
});

const CHOICE_OPTS = { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] };

test('a valid set passes and is normalised', () => {
  const out = validateQuestions({
    questions: [q('scope', 'choice', CHOICE_OPTS), q('stores', 'multi', CHOICE_OPTS), q('notes', 'text')],
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].options?.length, 2);
  assert.equal(out[2].options, undefined);
});

test(`the cap: more than ${QUESTION_CAP} questions is rejected with "prioritise"`, () => {
  const questions = Array.from({ length: QUESTION_CAP + 1 }, (_, i) => q(`q${i}`));
  assert.throws(() => validateQuestions({ questions }), /prioritise/);
});

test('exactly the cap is allowed', () => {
  const questions = Array.from({ length: QUESTION_CAP }, (_, i) => q(`q${i}`));
  assert.equal(validateQuestions({ questions }).length, QUESTION_CAP);
});

test('rejections: shape, empty set, ids, kinds, options', () => {
  assert.throws(() => validateQuestions('nope'), /expected/);
  assert.throws(() => validateQuestions({ questions: [] }), /empty/);
  assert.throws(() => validateQuestions({ questions: [q('Bad Id!')] }), /slug/);
  assert.throws(() => validateQuestions({ questions: [q('a'), q('a')] }), /duplicate/);
  assert.throws(() => validateQuestions({ questions: [q('a', 'rating')] }), /kind/);
  assert.throws(() => validateQuestions({ questions: [{ id: 'a', kind: 'text' }] }), /prompt/);
  // choice/multi need at least two options — one option is not a question.
  assert.throws(
    () => validateQuestions({ questions: [q('a', 'choice', { options: [{ value: 'x', label: 'X' }] })] }),
    /2 options/
  );
  assert.throws(
    () => validateQuestions({ questions: [q('a', 'choice', { options: [{ value: 1, label: 'X' }, { value: 'y', label: 'Y' }] })] }),
    /value and label/
  );
});
