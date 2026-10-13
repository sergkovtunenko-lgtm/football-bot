import { expect, it } from 'vitest';
import { createCloudflareWorker } from '../../src/cloudflare-worker';

it('does not acknowledge an update that could not be committed', async () => {
  const worker = createCloudflareWorker(() => ({
    router: { handle: async () => { throw new Error('D1 unavailable'); } },
    scheduler: { tick: async () => {} }, outbox: { flush: async () => ({ sent: 0, rescheduled: 0 }) },
  }));
  let acknowledged = false;
  let retryDelay = 0;
  await worker.queue({ messages: [{ body: { update_id: 12 }, attempts: 1,
    ack: () => { acknowledged = true; }, retry: ({ delaySeconds }) => { retryDelay = delaySeconds; } }] },
    { BOT_ACTIVE: 'true' } as any);
  expect(acknowledged).toBe(false);
  expect(retryDelay).toBe(30);
});

it('acknowledges a committed update and flushes only a bounded number of messages', async () => {
  let flushed = 0;
  let acknowledged = false;
  const worker = createCloudflareWorker(() => ({
    router: { handle: async () => {} }, scheduler: { tick: async () => {} },
    outbox: { flush: async (limit: number) => { flushed += limit; return { sent: 1, rescheduled: 0 }; } },
  }));
  await worker.queue({ messages: [{ body: { update_id: 12 }, attempts: 1, ack: () => { acknowledged = true; },
    retry: () => { throw new Error('unexpected retry'); } }] }, { BOT_ACTIVE: 'true' } as any);
  expect(acknowledged).toBe(true);
  expect(flushed).toBeGreaterThan(0);
  expect(flushed).toBeLessThanOrEqual(2);
});

it('does not send or consume production messages until explicitly activated', async () => {
  let retried = false;
  const worker = createCloudflareWorker(() => { throw new Error('runtime should remain inactive'); });
  await worker.scheduled({}, { BOT_ACTIVE: 'false' } as any);
  await worker.queue({ messages: [{ body: { update_id: 12 }, attempts: 1, ack: () => { throw new Error('lost message'); },
    retry: () => { retried = true; } }] }, { BOT_ACTIVE: 'false' } as any);
  expect(retried).toBe(true);
});

it('runs catch-up scheduling and delivery on the Cloudflare timer', async () => {
  const actions: string[] = [];
  const worker = createCloudflareWorker(() => ({
    router: { handle: async () => {} }, scheduler: { tick: async () => { actions.push('tick'); } },
    outbox: { flush: async () => { actions.push('flush'); return { sent: 0, rescheduled: 0 }; } },
  }));
  await worker.scheduled({}, { BOT_ACTIVE: 'true' } as any);
  expect(actions).toEqual(['tick', 'flush']);
});

it('catches up a missed opening before processing the first incoming update', async () => {
  const actions: string[] = [];
  const worker = createCloudflareWorker(() => ({
    router: { handle: async () => { actions.push('update'); } },
    scheduler: { tick: async () => { actions.push('tick'); } },
    outbox: { flush: async () => { actions.push('flush'); return { sent: 0, rescheduled: 0 }; } },
  }));
  await worker.queue({ messages: [{ body: { update_id: -1 }, attempts: 1,
    ack: () => { actions.push('ack'); }, retry: () => {} }] }, { BOT_ACTIVE: 'true' } as any);
  expect(actions).toEqual(['tick', 'update', 'flush', 'ack']);
});
