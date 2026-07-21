import { expect, it } from 'vitest';
import { Scheduler } from '../../src/application/scheduler';
import { InMemoryFootballStore } from '../support/in-memory-store';

function fixture(iso: string) {
  const store = new InMemoryFootballStore();
  let currentIso = iso;
  const clock = { now: () => new Date(currentIso) };
  let id = 0;
  return {
    store,
    scheduler: new Scheduler(store, clock, { int: () => 0 }, () => `effect-${++id}`),
    advanceTo: (nextIso: string) => { currentIso = nextIso; },
  };
}

it('deduplicates concurrent ticks atomically', async () => {
  const app = fixture('2026-07-21T07:00:00.000Z');
  await Promise.all([app.scheduler.tick(), app.scheduler.tick()]);
  expect(app.store.scheduledActionKeys()).toEqual(['2026-07-24:open']);
  expect(app.store.pendingEffects().filter((entry) => entry.effect.kind === 'registration_card')).toHaveLength(1);
});

it('opens during a Tuesday catch-up window', async () => {
  const app = fixture('2026-07-21T12:00:00.000Z');
  await app.scheduler.tick();
  expect(app.store.scheduledActionKeys()).toEqual(['2026-07-24:open']);
});

it('does not enqueue Wednesdays reminder on Thursday', async () => {
  const app = fixture('2026-07-21T08:00:00.000Z');
  await app.scheduler.tick();
  app.advanceTo('2026-07-23T08:00:00.000Z');
  await app.scheduler.tick();
  const reminders = app.store.pendingEffects().filter((entry) => entry.effect.kind === 'reminder');
  expect(reminders).toHaveLength(1);
  expect(reminders[0]?.effect).toMatchObject({ actionKey: '2026-07-24:reminder:thu' });
});

it('catches up Friday close after 20:55 Moscow', async () => {
  const app = fixture('2026-07-21T08:00:00.000Z');
  await app.scheduler.tick();
  app.advanceTo('2026-07-24T18:30:00.000Z');
  await app.scheduler.tick();
  expect(app.store.scheduledActionKeys()).toContain('2026-07-24:close');
  expect(app.store.pendingEffects().some((entry) => entry.effect.kind === 'teams')).toBe(true);
});

it('rolls back action and effect when a transaction fails', async () => {
  const app = fixture('2026-07-21T08:00:00.000Z');
  app.store.failNextEnqueue();
  await expect(app.scheduler.tick()).rejects.toThrow('injected enqueue failure');
  expect(app.store.scheduledActionKeys()).toEqual([]);
  expect(app.store.pendingEffects()).toEqual([]);
});
