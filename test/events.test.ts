import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/daemon/events.js';
import type { AgentEvent } from '../src/types.js';

const APPROVED: AgentEvent = { status: 'approved', approvedPath: '/x.md' };
const SHUTDOWN: AgentEvent = { status: 'shutdown' };

test('an event fired while nobody waits is queued and delivered on the next wait', async () => {
  const bus = new Bus();
  bus.wakeAgent(APPROVED);
  assert.deepEqual(await bus.wait(5), APPROVED);
  bus.close();
});

test('a pending waiter is woken immediately', async () => {
  const bus = new Bus();
  const waiting = bus.wait(5);
  bus.wakeAgent(APPROVED);
  assert.deepEqual(await waiting, APPROVED);
  bus.close();
});

test('wait times out with the sentinel, and the timeout is honoured', async () => {
  const bus = new Bus();
  const t0 = Date.now();
  assert.deepEqual(await bus.wait(1), { status: 'timeout' });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 900 && elapsed < 3000, String(elapsed));
  bus.close();
});

test('queued events are delivered in order, one per wait', async () => {
  const bus = new Bus();
  bus.wakeAgent(APPROVED);
  bus.wakeAgent(SHUTDOWN);
  assert.deepEqual(await bus.wait(5), APPROVED);
  assert.deepEqual(await bus.wait(5), SHUTDOWN);
  bus.close();
});

test('requeue puts an undelivered event back at the front', async () => {
  const bus = new Bus();
  bus.wakeAgent(SHUTDOWN);
  bus.requeue(APPROVED);
  assert.deepEqual(await bus.wait(5), APPROVED);
  assert.deepEqual(await bus.wait(5), SHUTDOWN);
  bus.close();
});

test('a second overlapping wait supersedes the first, which resolves timeout', async () => {
  const bus = new Bus();
  const first = bus.wait(30);
  const second = bus.wait(30);
  assert.deepEqual(await first, { status: 'timeout' });
  bus.wakeAgent(APPROVED);
  assert.deepEqual(await second, APPROVED);
  bus.close();
});

test('onPendingChange fires on queue growth and drain — the persistence hook', async () => {
  const bus = new Bus();
  const sizes: number[] = [];
  bus.onPendingChange = (p) => sizes.push(p.length);
  bus.wakeAgent(APPROVED); // queued: 1
  await bus.wait(5); // drained: 0
  assert.deepEqual(sizes, [1, 0]);
  bus.close();
});

test('close() releases a pending waiter as shutdown and disarms its timer', async () => {
  const bus = new Bus();
  // 600s timeout: if close() leaked the timer, this file would pin the
  // process for 10 minutes — the CI failure mode this guards against.
  const waiting = bus.wait(600);
  bus.close();
  assert.deepEqual(await waiting, { status: 'shutdown' });
});

test('seedPending restores a persisted queue without re-notifying', async () => {
  const bus = new Bus();
  const sizes: number[] = [];
  bus.onPendingChange = (p) => sizes.push(p.length);
  bus.seedPending([APPROVED]);
  assert.deepEqual(sizes, []);
  assert.deepEqual(await bus.wait(5), APPROVED);
  bus.close();
});
