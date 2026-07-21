import { describe, expect, it } from 'vitest';
import { BotService, ForbiddenError, InvalidStateError, NotFoundError } from '../../src/application/bot-service';
import { InMemoryFootballStore } from '../support/in-memory-store';

const clock = { now: () => new Date('2026-07-21T08:00:00.000Z') };
const random = { int: () => 0 };

function fixture(adminIds: ReadonlySet<string> = new Set(['900'])) {
  const store = new InMemoryFootballStore();
  let id = 0;
  const service = new BotService(store, clock, random, adminIds, () => `id-${++id}`);
  return { store, service };
}

async function open(app: ReturnType<typeof fixture>) {
  await app.service.setup('setup', '900', '-1001');
  await app.service.openNow('open', '900');
}

async function register(app: ReturnType<typeof fixture>, count: number) {
  for (let i = 1; i <= count; i += 1) {
    await app.service.setParty(`r-${i}`, { telegramUserId: String(i), displayName: `P${i}` }, 1);
  }
}

describe('BotService', () => {
  it('runs registration, close, wins, undo, and finish exactly once', async () => {
    const app = fixture();
    await open(app);
    await register(app, 10);
    const closed = await app.service.closeNow('close', '900');
    expect(closed.value?.teamCount).toBe(2);
    expect((await app.service.recordWin('win-1', '900', 1)).duplicate).toBe(false);
    expect((await app.service.recordWin('win-1', '900', 1)).duplicate).toBe(true);
    await app.service.undoLastWin('undo', '900');
    const finished = await app.service.finish('finish', '900');
    expect(finished.value?.leaderboard).toEqual([]);
  });

  it.each(['setup', 'close', 'win', 'undo', 'finish'])('rejects non-admin %s', async (method) => {
    const app = fixture();
    if (method !== 'setup') {
      await open(app);
      if (method !== 'close') {
        await register(app, 10);
        await app.service.closeNow('close', '900');
      }
    }
    const call = method === 'setup' ? app.service.setup('x', 'x', 'chat')
      : method === 'close' ? app.service.closeNow('x', 'x')
        : method === 'win' ? app.service.recordWin('x', 'x', 1)
          : method === 'undo' ? app.service.undoLastWin('x', 'x')
            : app.service.finish('x', 'x');
    await expect(call).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects registration outside registration_open', async () => {
    const app = fixture();
    await expect(app.service.setParty('before', { telegramUserId: '1', displayName: 'P1' }, 1))
      .rejects.toBeInstanceOf(InvalidStateError);
    await open(app);
    await register(app, 10);
    await app.service.closeNow('close', '900');
    await expect(app.service.setParty('after', { telegramUserId: '11', displayName: 'P11' }, 1))
      .rejects.toBeInstanceOf(InvalidStateError);
  });

  it('waitlists the 21st slot and promotes it after cancellation', async () => {
    const app = fixture();
    await open(app);
    await register(app, 21);
    expect((await app.service.registrationView()).waitlist.map((p) => p.displayName)).toEqual(['P21']);
    const changed = await app.service.setParty('cancel', { telegramUserId: '1', displayName: 'P1' }, 0);
    expect(changed.value?.promotedOwnerIds).toEqual(['21']);
    expect(app.store.pendingEffects().some((entry) => entry.effect.kind === 'promotion_notice')).toBe(true);
  });

  it('closes with insufficient players without starting play', async () => {
    const app = fixture();
    await open(app);
    await register(app, 9);
    expect((await app.service.closeNow('close', '900')).value?.teamCount).toBe(0);
    expect((await app.service.status()).sessionStatus).toBe('registration_closed');
    expect(app.store.pendingEffects().filter((entry) => entry.effect.kind === 'teams')).toHaveLength(1);
    expect(app.store.pendingEffects().filter((entry) => entry.effect.kind === 'score_panel')).toHaveLength(0);
  });

  it('persists two teams when ten players close', async () => {
    const app = fixture();
    await open(app);
    await register(app, 10);
    await app.service.closeNow('close', '900');
    expect((await app.service.status()).teamCount).toBe(2);
    expect((await app.service.status()).sessionStatus).toBe('playing');
  });

  it('rejects a win for an unknown team', async () => {
    const app = fixture();
    await open(app);
    await register(app, 10);
    await app.service.closeNow('close', '900');
    await expect(app.service.recordWin('win', '900', 3)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('awards player starters and reserves, but not guests', async () => {
    const app = fixture();
    await open(app);
    for (let i = 1; i <= 9; i += 1) await app.service.setParty(`r-${i}`, { telegramUserId: String(i), displayName: `P${i}` }, 1);
    await app.service.setParty('party', { telegramUserId: '10', displayName: 'P10' }, 2);
    await app.service.closeNow('close', '900');
    const members = await app.store.transact((tx) => tx.listTeamMembers('2026-07-24'));
    const reserve = members.find((member) => member.role === 'reserve')!;
    await app.service.recordWin('win', '900', reserve.teamNumber);
    const awards = await app.store.transact((tx) => tx.listWinAwards('2026-07-24'));
    expect(awards.some((award) => award.telegramUserId === reserve.telegramUserId)).toBe(true);
    expect(awards).toHaveLength(members.filter((member) => member.teamNumber === reserve.teamNumber && member.kind === 'player').length);
  });

  it('undoes only the highest active ordinal', async () => {
    const app = fixture();
    await open(app); await register(app, 10); await app.service.closeNow('close', '900');
    await app.service.recordWin('w1', '900', 1); await app.service.recordWin('w2', '900', 2);
    expect((await app.service.undoLastWin('undo', '900')).value?.reversedOrdinal).toBe(2n);
    const events = await app.store.transact((tx) => tx.listWinEvents('2026-07-24'));
    expect(events.find((event) => event.ordinal === 1n)?.reversedAtIso).toBeUndefined();
  });

  it('finishes idempotently and locks further wins', async () => {
    const app = fixture();
    await open(app); await register(app, 10); await app.service.closeNow('close', '900');
    await app.service.finish('finish-1', '900');
    expect((await app.service.finish('finish-2', '900')).value?.leaderboard).toEqual([]);
    expect(app.store.pendingEffects().filter((entry) => entry.effect.kind === 'final_results')).toHaveLength(1);
    await expect(app.service.recordWin('win', '900', 1)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('includes only completed sessions in the final leaderboard', async () => {
    const app = fixture();
    await open(app); await register(app, 10); await app.service.closeNow('close', '900');
    await app.service.recordWin('win', '900', 1);
    const before = await app.store.transact(async (tx) => ({
      events: await tx.listWinEvents(), awards: await tx.listWinAwards(), completed: await tx.listCompletedSessionIds(),
    }));
    expect(before.completed.size).toBe(0);
    expect((await app.service.finish('finish', '900')).value?.leaderboard.length).toBeGreaterThan(0);
  });

  it('reports phase, counts, next action, and operational data', async () => {
    const app = fixture();
    await open(app); await register(app, 2);
    await app.store.rescheduleEffect('id-1', 1, clock.now().toISOString(), 'safe only');
    const status = await app.service.status();
    expect(status).toMatchObject({ sessionStatus: 'registration_open', activeCount: 2, waitlistCount: 0, teamCount: 0 });
    expect(status.nextActionKind).toBeDefined();
    expect(status.pendingEffectCount).toBeGreaterThan(0);
    expect(status.lastSafeError).toBe('safe only');
    expect(JSON.stringify(status)).not.toContain('-1001');
  });
});
