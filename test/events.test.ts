import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Bus, Hub } from '../src/daemon/events.js';
import type { AgentEvent } from '../src/types.js';

interface FakeRes {
  frames: string[];
  ended: boolean;
}

/** Just enough of a ServerResponse for the SSE fan-out paths. */
function fakeRes(): ServerResponse & FakeRes {
  const res = Object.assign(new EventEmitter(), {
    frames: [] as string[],
    ended: false,
    write(chunk: string) {
      res.frames.push(chunk);
      return true;
    },
    end() {
      res.ended = true;
      return res;
    },
  });
  return res as unknown as ServerResponse & FakeRes;
}

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

// ---- per-session isolation: one Bus per session, never shared ---------------

test('waking one session does not resolve another session parked in wait', async () => {
  const a = new Bus();
  const b = new Bus();
  const parked = b.wait(1);
  a.wakeAgent(APPROVED);
  // b's agent stays parked and times out; only a's is woken.
  assert.deepEqual(await parked, { status: 'timeout' });
  assert.deepEqual(await a.wait(5), APPROVED);
  a.close();
  b.close();
});

test('pending queues persist per session — one Store never sees another’s events', async () => {
  const a = new Bus();
  const b = new Bus();
  const aSaved: AgentEvent[][] = [];
  const bSaved: AgentEvent[][] = [];
  a.onPendingChange = (p) => aSaved.push([...p]);
  b.onPendingChange = (p) => bSaved.push([...p]);

  a.wakeAgent(APPROVED);
  assert.deepEqual(aSaved, [[APPROVED]]);
  assert.deepEqual(bSaved, [], 'b must not observe a’s event');

  b.wakeAgent(SHUTDOWN);
  assert.deepEqual(await a.wait(5), APPROVED);
  assert.deepEqual(await b.wait(5), SHUTDOWN);
  a.close();
  b.close();
});

test('an SSE broadcast reaches only the session that fired it', () => {
  const a = new Bus();
  const b = new Bus();
  const ra = fakeRes();
  const rb = fakeRes();
  a.addClient(ra);
  b.addClient(rb);
  a.broadcast('revision', { revision: 2 });
  assert.equal(ra.frames.length, 1);
  assert.match(ra.frames[0], /event: revision\ndata: {"revision":2}\n\n/);
  assert.deepEqual(rb.frames, []);
  a.close();
  b.close();
});

// ---- Hub: the daemon-level fan-out for session-list changes -----------------

test('Hub broadcasts to every tab regardless of the session it is viewing', () => {
  const hub = new Hub();
  const one = fakeRes();
  const two = fakeRes();
  hub.add(one);
  hub.add(two);
  hub.broadcast('sessions', { id: 'plan-1' });
  for (const res of [one, two]) {
    assert.match(res.frames[0], /event: sessions\ndata: {"id":"plan-1"}\n\n/);
  }
  hub.close();
  assert.ok(one.ended && two.ended);
});

test('Hub drops a client when its response closes', () => {
  const hub = new Hub();
  const res = fakeRes();
  hub.add(res);
  res.emit('close');
  hub.broadcast('sessions');
  assert.deepEqual(res.frames, [], 'a closed client must not be written to');
});

test('one response registered on both a Bus and the Hub receives both streams', () => {
  const bus = new Bus();
  const hub = new Hub();
  const res = fakeRes();
  bus.addClient(res);
  hub.add(res);
  bus.broadcast('status', { status: 'review' });
  hub.broadcast('sessions');
  assert.equal(res.frames.length, 2);
  bus.close();
});
