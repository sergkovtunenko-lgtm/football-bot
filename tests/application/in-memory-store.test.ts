import { describe, expect, it } from 'vitest';
import { InMemoryFootballStore } from '../support/in-memory-store';

describe('InMemoryFootballStore contract', () => {
  it('serializes concurrent update dedupe with the business commit', async () => {
    const store = new InMemoryFootballStore();
    let calls = 0;
    const work = store.transactUpdate('same-update', '2026-07-21T08:00:00.000Z', async (tx) => {
      calls += 1;
      await tx.saveSettings({ groupChatId: '-1001' });
      return 'saved';
    });
    const duplicate = store.transactUpdate('same-update', '2026-07-21T08:00:00.000Z', async () => {
      calls += 1;
      return 'should-not-run';
    });

    expect(await Promise.all([work, duplicate])).toEqual([
      { duplicate: false, value: 'saved' },
      { duplicate: true },
    ]);
    expect(calls).toBe(1);
    expect(await store.transact((tx) => tx.getSettings())).toEqual({ groupChatId: '-1001' });
  });

  it('rolls back business state and the update marker together', async () => {
    const store = new InMemoryFootballStore();
    await expect(store.transactUpdate('retryable', '2026-07-21T08:00:00.000Z', async (tx) => {
      await tx.saveSettings({ groupChatId: 'not-committed' });
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(await store.transact((tx) => tx.getSettings())).toEqual({});

    const retry = await store.transactUpdate('retryable', '2026-07-21T08:00:01.000Z', async (tx) => {
      await tx.saveSettings({ groupChatId: 'committed' });
      return 1;
    });
    expect(retry).toEqual({ duplicate: false, value: 1 });
  });

  it('excludes active leases and reclaims expired leases', async () => {
    const store = new InMemoryFootballStore();
    await store.transact((tx) => tx.enqueue(
      'effect-1',
      { kind: 'registration_card', sessionId: '2026-07-24' },
      '2026-07-21T08:00:00.000Z',
    ));

    expect(await store.claimDueEffects('2026-07-21T08:00:00.000Z', 1, 'lease-1')).toHaveLength(1);
    expect(await store.claimDueEffects('2026-07-21T08:00:29.999Z', 1, 'lease-2')).toEqual([]);
    expect(await store.claimDueEffects('2026-07-21T08:00:30.000Z', 1, 'lease-3')).toHaveLength(1);
  });
});
