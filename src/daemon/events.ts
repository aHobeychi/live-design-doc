import type { ServerResponse } from 'node:http';
import type { AgentEvent, WaitResult } from '../types.js';

/**
 * One in-process bus with two audiences:
 *  - SSE clients (browser tabs): broadcast, fire-and-forget.
 *  - The agent's single long-poll: wakeAgent either resolves the pending wait
 *    or queues the event until the next `wait` call. Events that fire while
 *    the agent is away are never dropped (design §3.2).
 */
export class Bus {
  private sseClients = new Set<ServerResponse>();
  private waiter: ((e: WaitResult) => void) | null = null;
  private pending: AgentEvent[] = [];
  private heartbeat: NodeJS.Timeout;

  /** Persistence hook — called whenever the pending queue changes. */
  onPendingChange: ((pending: AgentEvent[]) => void) | null = null;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const res of this.sseClients) res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  seedPending(events: AgentEvent[]): void {
    this.pending.push(...events);
  }

  addClient(res: ServerResponse): void {
    this.sseClients.add(res);
    res.on('close', () => this.sseClients.delete(res));
  }

  broadcast(event: string, data: unknown = {}): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) res.write(frame);
  }

  wakeAgent(event: AgentEvent): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(event);
    } else {
      this.pending.push(event);
      this.onPendingChange?.(this.pending);
    }
  }

  /** Put an undelivered event back at the front of the queue. */
  requeue(event: AgentEvent): void {
    this.pending.unshift(event);
    this.onPendingChange?.(this.pending);
  }

  wait(timeoutSec: number): Promise<WaitResult> {
    if (this.pending.length > 0) {
      const event = this.pending.shift()!;
      this.onPendingChange?.(this.pending);
      return Promise.resolve(event);
    }
    // A second overlapping wait supersedes the first, which times out at once.
    if (this.waiter) {
      const stale = this.waiter;
      this.waiter = null;
      queueMicrotask(() => stale({ status: 'timeout' }));
    }
    return new Promise<WaitResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === take) this.waiter = null;
        resolve({ status: 'timeout' });
      }, Math.max(1, timeoutSec) * 1000);
      timer.unref();
      const take = (e: WaitResult) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiter = take;
    });
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
  }
}
