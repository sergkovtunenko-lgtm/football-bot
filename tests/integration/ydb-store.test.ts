import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '@ydbjs/core';
import { query, type QueryClient } from '@ydbjs/query';
import type { Participant, Session, WinAward } from '../../src/domain/model';
import { getYdbDriver } from '../../src/adapters/ydb/connection';
import { runMigrations } from '../../src/adapters/ydb/migrate';
import { YdbFootballStore } from '../../src/adapters/ydb/store';

const connectionString = process.env.YDB_TEST_CONNECTION_STRING;
const suiteName = connectionString
  ? 'YdbFootballStore integration'
  : 'YdbFootballStore integration (skipped: YDB_TEST_CONNECTION_STRING is absent)';
const describeYdb = connectionString ? describe : describe.skip;
if (!connectionString) {
  process.stdout.write('[YDB integration skipped] YDB_TEST_CONNECTION_STRING is absent\n');
}

describeYdb(suiteName, () => {
  let driver: Driver;
  let cleanupSql: QueryClient;
  let store: YdbFootballStore;

  beforeAll(async () => {
    driver = await getYdbDriver(requiredConnectionString());
    await runMigrations(driver);
    await runMigrations(driver);
    cleanupSql = query(driver);
    store = new YdbFootballStore(driver);
  });

  beforeEach(async () => {
    for (const table of [
      'win_awards', 'win_events', 'team_members', 'teams', 'participants', 'players',
      'scheduled_actions', 'processed_updates', 'outbox', 'sessions', 'settings',
    ]) {
      await cleanupSql`DELETE FROM ${cleanupSql.identifier(table)}`;
    }
  });

  afterAll(async () => {
    if (cleanupSql) await cleanupSql[Symbol.asyncDispose]();
    if (driver) driver.close();
  });

  it('runs migration 1 twice and records its version', async () => {
    const [rows] = await cleanupSql<[{ version: number }]>`
      SELECT version FROM schema_migrations WHERE version = 1u
    `;
    expect(rows).toEqual([{ version: 1 }]);
  });

  it('deduplicates update and business writes in one transaction', async () => {
    const now = '2026-07-21T08:00:00.000Z';
    const first = await store.transactUpdate('42', now, async (tx) => {
      await tx.saveSettings({ groupChatId: '-100' });
      return 'saved';
    });
    const second = await store.transactUpdate('42', now, async () => 'must-not-run');

    expect(first).toEqual({ duplicate: false, value: 'saved' });
    expect(second).toEqual({ duplicate: true });
    expect(await store.transact((tx) => tx.getSettings())).toEqual({ groupChatId: '-100' });
  });

  it('rolls back the update marker and all business writes together', async () => {
    await expect(store.transactUpdate('retryable', '2026-07-21T08:00:00.000Z', async (tx) => {
      await tx.saveSettings({ groupChatId: 'not-committed' });
      throw new Error('stop');
    })).rejects.toThrow();
    expect(await store.transact((tx) => tx.getSettings())).toEqual({});

    expect(await store.transactUpdate('retryable', '2026-07-21T08:00:01.000Z', async (tx) => {
      await tx.saveSettings({ groupChatId: 'committed' });
      return 1;
    })).toEqual({ duplicate: false, value: 1 });
  });

  it('round-trips players and sessions while omitting absent optional properties', async () => {
    const session: Session = {
      sessionId: '2026-07-24', status: 'registration_open', nextQueuePosition: 2n, nextWinOrdinal: 1n,
    };
    await store.transact(async (tx) => {
      await tx.upsertPlayer({ telegramUserId: '2', displayName: 'Beta' }, '2026-07-21T08:00:00.123Z');
      await tx.upsertPlayer({ telegramUserId: '1', displayName: 'Alpha', username: 'alpha' }, '2026-07-21T08:00:00.456Z');
      await tx.saveSession(session);
    });

    expect(await store.transact((tx) => tx.listPlayers())).toEqual([
      { telegramUserId: '1', displayName: 'Alpha', username: 'alpha' },
      { telegramUserId: '2', displayName: 'Beta' },
    ]);
    expect(await store.transact((tx) => tx.getSession(session.sessionId))).toEqual(session);
    expect(await store.transact((tx) => tx.getSession('missing'))).toBeUndefined();

    await store.transact((tx) => tx.saveSession({
      ...session, status: 'finished', nextQueuePosition: 3n, scoreMessageId: '99',
    }));
    expect(await store.transact((tx) => tx.getSession(session.sessionId))).toEqual({
      ...session, status: 'finished', nextQueuePosition: 3n, scoreMessageId: '99',
    });
  });

  it('atomically replaces an unbounded participant waitlist', async () => {
    const first = participants('s', 25);
    await store.transact((tx) => tx.replaceParticipants('s', first));
    expect(await store.transact((tx) => tx.listParticipants('s'))).toEqual(first);

    const replacement = [first[24]!, first[0]!];
    await store.transact((tx) => tx.replaceParticipants('s', replacement));
    expect(await store.transact((tx) => tx.listParticipants('s'))).toEqual([first[0], first[24]]);
  });

  it('replaces teams and persists only the first 20 active member slots', async () => {
    const roster = participants('s', 22).map((participant) => ({
      ...participant,
      rosterStatus: 'active' as const,
      teamNumber: ((Number(participant.queuePosition - 1n) % 4) + 1) as 1 | 2 | 3 | 4,
      role: 'starter' as const,
    }));
    await store.transact(async (tx) => {
      await tx.replaceParticipants('s', roster);
      await tx.replaceTeams('s', [1, 2, 3, 4].map((teamNumber) => ({
        sessionId: 's', teamNumber: teamNumber as 1 | 2 | 3 | 4,
      })), roster);
    });

    expect(await store.transact((tx) => tx.listTeams('s'))).toEqual([1, 2, 3, 4].map((teamNumber) => ({
      sessionId: 's', teamNumber,
    })));
    expect(await store.transact((tx) => tx.listTeamMembers('s'))).toHaveLength(20);

    await store.transact((tx) => tx.replaceTeams('s', [{ sessionId: 's', teamNumber: 1 }], [roster[0]!]));
    expect(await store.transact((tx) => tx.listTeams('s'))).toEqual([{ sessionId: 's', teamNumber: 1 }]);
    expect(await store.transact((tx) => tx.listTeamMembers('s'))).toEqual([roster[0]]);
  });

  it('enforces unique win awards and reverses a win without deleting history', async () => {
    const event = {
      sessionId: 's', ordinal: 1n, teamNumber: 2 as const, adminUserId: 'admin',
      createdAtIso: '2026-07-21T08:00:00.123Z',
    };
    const award: WinAward = { sessionId: 's', winOrdinal: 1n, telegramUserId: '1', displayName: 'Alpha' };
    await store.transact((tx) => tx.appendWin(event, [award]));

    await expect(store.transact((tx) => tx.appendWin(
      { ...event, ordinal: 2n },
      [{ ...award, winOrdinal: 2n }, { ...award, winOrdinal: 2n }],
    ))).rejects.toThrow();
    expect(await store.transact((tx) => tx.listWinEvents('s'))).toEqual([event]);
    expect(await store.transact((tx) => tx.listWinAwards('s'))).toEqual([award]);

    await store.transact((tx) => tx.reverseWin('s', 1n, '2026-07-21T08:05:00.456Z'));
    expect(await store.transact((tx) => tx.listWinEvents())).toEqual([
      { ...event, reversedAtIso: '2026-07-21T08:05:00.456Z' },
    ]);
  });

  it('selects only completed sessions and enforces unique schedule keys', async () => {
    await store.transact(async (tx) => {
      await tx.saveSession(session('open', 'playing'));
      await tx.saveSession(session('done', 'finished'));
      await tx.markScheduledAction('open:done', 'done', 'open', '2026-07-21T08:00:00.000Z');
    });

    expect(await store.transact((tx) => tx.listCompletedSessionIds())).toEqual(new Set(['done']));
    expect(await store.transact((tx) => tx.hasScheduledAction('open:done'))).toBe(true);
    expect(await store.transact((tx) => tx.hasScheduledAction('missing'))).toBe(false);
    await expect(store.transact((tx) => tx.markScheduledAction(
      'open:done', 'done', 'open', '2026-07-21T08:01:00.000Z',
    ))).rejects.toThrow();
  });

  it('leases effects deterministically and applies rescheduled, sent, and failed transitions', async () => {
    await store.transact(async (tx) => {
      await tx.enqueue('b', { kind: 'teams', sessionId: 's' }, '2026-07-21T08:00:00.000Z');
      await tx.enqueue('a', { kind: 'registration_card', sessionId: 's' }, '2026-07-21T08:00:00.000Z');
      await tx.enqueue('c', { kind: 'admin_error', correlationId: 'corr', summary: 'safe' }, '2026-07-21T08:01:00.000Z');
    });

    expect((await store.claimDueEffects('2026-07-21T08:00:00.000Z', 2, 'lease-1')).map(({ effectId }) => effectId))
      .toEqual(['a', 'b']);
    expect(await store.claimDueEffects('2026-07-21T08:00:29.999Z', 5, 'lease-2')).toEqual([]);
    expect((await store.claimDueEffects('2026-07-21T08:00:30.000Z', 1, 'lease-3')).map(({ effectId }) => effectId))
      .toEqual(['a']);

    const unsafeError = `123456789:abcdefghijklmnopqrstuvwxyzABCDE_ ${'x'.repeat(600)}`;
    await store.rescheduleEffect('a', 2, '2026-07-21T08:02:00.000Z', 'retryable');
    await store.markEffectSent('b', '2026-07-21T08:00:31.123Z');
    await store.markEffectPermanentlyFailed('c', '2026-07-21T08:00:31.456Z', unsafeError);

    const [rows] = await cleanupSql<[OutboxState]>`
      SELECT effect_id, status, attempts, lease_id, lease_until, sent_at, failed_at, last_error
      FROM outbox ORDER BY effect_id
    `;
    expect(rows[0]).toMatchObject({ effect_id: 'a', status: 'pending', attempts: 2, lease_id: null, lease_until: null });
    expect(rows[0]!.last_error).toBe('retryable');
    expect(rows[1]).toMatchObject({ effect_id: 'b', status: 'sent', lease_id: null, lease_until: null });
    expect((rows[1]!.sent_at as Date).toISOString()).toBe('2026-07-21T08:00:31.123Z');
    expect(rows[2]).toMatchObject({ effect_id: 'c', status: 'failed', lease_id: null, lease_until: null });
    expect(rows[2]!.failed_at?.toISOString()).toBe('2026-07-21T08:00:31.456Z');
    expect(rows[2]!.last_error).not.toContain('123456789:');
    expect(rows[2]!.last_error).toHaveLength(500);
    expect(await store.getOperationalStatus()).toEqual({ pendingEffectCount: 1, lastSafeError: rows[2]!.last_error });

    expect((await store.claimDueEffects('2026-07-21T08:02:00.000Z', 1, 'lease-4'))[0]).toEqual({
      effectId: 'a', effect: { kind: 'registration_card', sessionId: 's' }, attempts: 2,
      nextAttemptAtIso: '2026-07-21T08:02:00.000Z',
    });
  });
});

interface OutboxState {
  effect_id: string;
  status: string;
  attempts: number;
  lease_id: string | null;
  lease_until: Date | null;
  sent_at: Date | null;
  failed_at: Date | null;
  last_error: string | null;
}

function session(sessionId: string, status: Session['status']): Session {
  return { sessionId, status, nextQueuePosition: 1n, nextWinOrdinal: 1n };
}

function requiredConnectionString(): string {
  if (!connectionString) throw new Error('YDB_TEST_CONNECTION_STRING is required for YDB integration tests');
  return connectionString;
}

function participants(sessionId: string, count: number): Participant[] {
  return Array.from({ length: count }, (_, index) => ({
    participantId: `p-${String(index + 1).padStart(2, '0')}`,
    sessionId,
    ownerUserId: `owner-${index + 1}`,
    ...(index % 2 === 0 ? { telegramUserId: String(index + 1) } : {}),
    displayName: `Player ${index + 1}`,
    kind: index % 2 === 0 ? 'player' as const : 'guest' as const,
    ...(index % 2 === 0 ? {} : { guestNumber: 1 as const }),
    queuePosition: BigInt(index + 1),
    rosterStatus: index < 20 ? 'active' as const : 'waitlist' as const,
  }));
}
