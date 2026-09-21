import { describe, expect, it } from 'vitest';
import { BotService, ForbiddenError, NotFoundError } from '../../src/application/bot-service';
import type { Participant, Session, TeamMember, WinAward, WinEvent } from '../../src/domain/model';
import { InMemoryFootballStore } from '../support/in-memory-store';

const clock = { now: () => new Date('2026-07-21T08:00:00.000Z') };
const random = { int: () => 0 };
const currentSessionId = '2026-07-24';

function fixture(adminIds: ReadonlySet<string> = new Set(['900'])) {
  const store = new InMemoryFootballStore();
  let id = 0;
  return {
    store,
    service: new BotService(store, clock, random, adminIds, () => `id-${++id}`),
  };
}

describe('admin cancellation workflow', () => {
  it.each([undefined, 'registration_open', 'registration_closed', 'playing', 'finished', 'cancelled'] as const)(
    'cancels a %s current session without retaining its statistics',
    async (status) => {
      const app = fixture();
      if (status) await seedFinishedLikeSession(app.store, currentSessionId, status);

      const result = await app.service.cancelCurrentSession(`cancel-${status ?? 'absent'}`, '900');

      expect(result).toEqual({ duplicate: false, value: { sessionId: currentSessionId } });
      await app.store.transact(async (tx) => {
        expect(await tx.getSession(currentSessionId)).toEqual({
          sessionId: currentSessionId,
          status: 'cancelled',
          nextQueuePosition: 1n,
          nextWinOrdinal: 1n,
        });
        expect(await tx.listParticipants(currentSessionId)).toEqual([]);
        expect(await tx.listTeams(currentSessionId)).toEqual([]);
        expect(await tx.listTeamMembers(currentSessionId)).toEqual([]);
        expect(await tx.listWinEvents(currentSessionId)).toEqual([]);
        expect(await tx.listWinAwards(currentSessionId)).toEqual([]);
        expect(await tx.listCompletedSessionIds()).not.toContain(currentSessionId);
      });
      expect(app.store.pendingEffects().filter((entry) => entry.effect.kind === 'session_cancelled'))
        .toEqual([expect.objectContaining({ effect: { kind: 'session_cancelled', sessionId: currentSessionId } })]);
    },
  );

  it('rejects a cancellation confirmation from a non-administrator', async () => {
    const app = fixture();

    await expect(app.service.cancelCurrentSession('cancel', 'not-admin')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('does not queue another cancellation notice for a duplicate update', async () => {
    const app = fixture();

    expect(await app.service.cancelCurrentSession('cancel', '900')).toMatchObject({ duplicate: false });
    expect(await app.service.cancelCurrentSession('cancel', '900')).toEqual({ duplicate: true });
    expect(app.store.pendingEffects().filter((entry) => entry.effect.kind === 'session_cancelled')).toHaveLength(1);
  });

  it('leaves one cancellation notice after a second nonduplicate cancellation', async () => {
    const app = fixture();

    await app.service.cancelCurrentSession('first-cancel', '900');
    await app.service.cancelCurrentSession('second-cancel', '900');

    expect(app.store.pendingEffects().filter((entry) => entry.effect.kind === 'session_cancelled')).toEqual([
      expect.objectContaining({ effect: { kind: 'session_cancelled', sessionId: currentSessionId } }),
    ]);
  });
});

describe('absence correction workflow', () => {
  it('returns participants of the lexicographically latest finished session', async () => {
    const app = fixture();
    await seedFinishedLikeSession(app.store, '2026-07-17', 'finished');
    await seedFinishedLikeSession(app.store, '2026-07-24', 'finished');

    await expect(app.service.latestFinishedParticipants()).resolves.toEqual({
      sessionId: '2026-07-24',
      participants: [playerParticipant('2026-07-24'), guestParticipant('2026-07-24')],
    });
  });

  it('removes exactly the selected player and that player’s win award', async () => {
    const app = fixture();
    await seedFinishedLikeSession(app.store, currentSessionId, 'finished');

    const result = await app.service.removeAbsentParticipant('absent-player', '900', currentSessionId, 'player-participant');

    expect(result).toEqual({ duplicate: false, value: undefined });
    await app.store.transact(async (tx) => {
      expect(await tx.listParticipants(currentSessionId)).toEqual([guestParticipant(currentSessionId)]);
      expect(await tx.listTeamMembers(currentSessionId)).toEqual([guestMember(currentSessionId)]);
      expect(await tx.listWinAwards(currentSessionId)).toEqual([guestOwnerAward(currentSessionId)]);
      expect(await tx.listWinEvents(currentSessionId)).toEqual([winEvent(currentSessionId)]);
    });
  });

  it('removes a guest without removing the guest owner or anyone else’s award', async () => {
    const app = fixture();
    await seedFinishedLikeSession(app.store, currentSessionId, 'finished');

    await app.service.removeAbsentParticipant('absent-guest', '900', currentSessionId, 'guest-participant');

    await app.store.transact(async (tx) => {
      expect(await tx.listParticipants(currentSessionId)).toEqual([playerParticipant(currentSessionId)]);
      expect(await tx.listTeamMembers(currentSessionId)).toEqual([playerMember(currentSessionId)]);
      expect(await tx.listWinAwards(currentSessionId)).toEqual([
        playerAward(currentSessionId),
        guestOwnerAward(currentSessionId),
      ]);
      expect(await tx.listWinEvents(currentSessionId)).toEqual([winEvent(currentSessionId)]);
    });
  });

  it('rejects absence correction from a non-administrator', async () => {
    const app = fixture();
    await seedFinishedLikeSession(app.store, currentSessionId, 'finished');

    await expect(app.service.removeAbsentParticipant('absent', 'not-admin', currentSessionId, 'player-participant'))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects an older completed session id as a stale action', async () => {
    const app = fixture();
    await seedFinishedLikeSession(app.store, '2026-07-17', 'finished');
    await seedFinishedLikeSession(app.store, currentSessionId, 'finished');

    await expect(app.service.removeAbsentParticipant('stale-session', '900', '2026-07-17', 'player-participant'))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a participant id that is no longer present as a stale action', async () => {
    const app = fixture();
    await seedFinishedLikeSession(app.store, currentSessionId, 'finished');

    await expect(app.service.removeAbsentParticipant('stale-participant', '900', currentSessionId, 'missing'))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports no latest session when no session has finished', async () => {
    const app = fixture();

    await expect(app.service.latestFinishedParticipants()).rejects.toBeInstanceOf(NotFoundError);
  });
});

async function seedFinishedLikeSession(
  store: InMemoryFootballStore,
  sessionId: string,
  status: Session['status'],
): Promise<void> {
  await store.transact(async (tx) => {
    await tx.saveSession({
      sessionId,
      status,
      nextQueuePosition: 3n,
      nextWinOrdinal: 2n,
      registrationMessageId: '11',
      scoreMessageId: '12',
    });
    await tx.replaceParticipants(sessionId, [playerParticipant(sessionId), guestParticipant(sessionId)]);
    await tx.replaceTeams(sessionId, [{ sessionId, teamNumber: 1 }], [playerMember(sessionId), guestMember(sessionId)]);
    await tx.appendWin(winEvent(sessionId), [playerAward(sessionId), guestOwnerAward(sessionId)]);
  });
}

function playerParticipant(sessionId: string): Participant {
  return {
    participantId: 'player-participant', sessionId, ownerUserId: 'player-1', telegramUserId: 'player-1',
    displayName: 'Player One', kind: 'player', queuePosition: 1n, rosterStatus: 'active',
  };
}

function guestParticipant(sessionId: string): Participant {
  return {
    participantId: 'guest-participant', sessionId, ownerUserId: 'player-2',
    displayName: 'Player Two guest', kind: 'guest', guestNumber: 1, queuePosition: 2n, rosterStatus: 'active',
  };
}

function playerMember(sessionId: string): TeamMember {
  return { ...playerParticipant(sessionId), teamNumber: 1, role: 'starter' };
}

function guestMember(sessionId: string): TeamMember {
  return { ...guestParticipant(sessionId), teamNumber: 1, role: 'starter' };
}

function winEvent(sessionId: string): WinEvent {
  return { sessionId, ordinal: 1n, teamNumber: 1, adminUserId: 'admin', createdAtIso: '2026-07-24T20:00:00.000Z' };
}

function playerAward(sessionId: string): WinAward {
  return { sessionId, winOrdinal: 1n, telegramUserId: 'player-1', displayName: 'Player One' };
}

function guestOwnerAward(sessionId: string): WinAward {
  return { sessionId, winOrdinal: 1n, telegramUserId: 'player-2', displayName: 'Player Two' };
}
