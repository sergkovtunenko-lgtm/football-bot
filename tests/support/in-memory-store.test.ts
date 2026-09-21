import { describe, expect, it } from 'vitest';
import type { Participant, Session, TeamMember, WinAward, WinEvent } from '../../src/domain/model';
import { InMemoryFootballStore } from './in-memory-store';

const targetSessionId = '2026-09-18';
const otherSessionId = '2026-09-25';

describe('InMemoryFootballStore persistence contract', () => {
  it('cancels one session without changing unrelated session or global rows', async () => {
    const store = new InMemoryFootballStore();
    await seedSessions(store);

    await store.transact((tx) => tx.cancelSession(targetSessionId));

    await store.transact(async (tx) => {
      expect(await tx.getSession(targetSessionId)).toEqual({
        sessionId: targetSessionId,
        status: 'cancelled',
        nextQueuePosition: 1n,
        nextWinOrdinal: 1n,
      });
      expect(await tx.listParticipants(targetSessionId)).toEqual([]);
      expect(await tx.listTeams(targetSessionId)).toEqual([]);
      expect(await tx.listTeamMembers(targetSessionId)).toEqual([]);
      expect(await tx.listWinEvents(targetSessionId)).toEqual([]);
      expect(await tx.listWinAwards(targetSessionId)).toEqual([]);
      expect(await tx.hasScheduledAction(`${targetSessionId}:finish`)).toBe(false);
      expect(await tx.listPlayers()).toEqual([
        { telegramUserId: 'player-1', displayName: 'Player One' },
        { telegramUserId: 'player-2', displayName: 'Player Two' },
      ]);
      expect(await tx.getSession(otherSessionId)).toEqual(session(otherSessionId, 'finished'));
      expect(await tx.listParticipants(otherSessionId)).toEqual([otherParticipant]);
      expect(await tx.listTeams(otherSessionId)).toEqual([{ sessionId: otherSessionId, teamNumber: 1 }]);
      expect(await tx.listTeamMembers(otherSessionId)).toEqual([otherMember]);
      expect(await tx.listWinEvents(otherSessionId)).toEqual([otherEvent]);
      expect(await tx.listWinAwards(otherSessionId)).toEqual([otherAward]);
      expect(await tx.hasScheduledAction(`${otherSessionId}:finish`)).toBe(true);
    });
    expect(store.pendingEffects()).toEqual([
      expect.objectContaining({ effectId: 'other-effect', effect: { kind: 'teams', sessionId: otherSessionId } }),
    ]);
  });

  it('removes only one named player and that player’s awards from a finished session', async () => {
    const store = new InMemoryFootballStore();
    await seedSessions(store);

    await store.transact((tx) => tx.removeCompletedParticipant(targetSessionId, playerParticipant.participantId));

    await store.transact(async (tx) => {
      expect(await tx.listParticipants(targetSessionId)).toEqual([guestParticipant]);
      expect(await tx.listTeamMembers(targetSessionId)).toEqual([guestMember]);
      expect(await tx.listWinAwards(targetSessionId)).toEqual([guestOwnerAward]);
      expect(await tx.listWinEvents(targetSessionId)).toEqual([targetEvent]);
    });
  });

  it('removes a guest without deleting awards belonging to that guest’s owner', async () => {
    const store = new InMemoryFootballStore();
    await seedSessions(store);

    await store.transact((tx) => tx.removeCompletedParticipant(targetSessionId, guestParticipant.participantId));

    await store.transact(async (tx) => {
      expect(await tx.listParticipants(targetSessionId)).toEqual([playerParticipant]);
      expect(await tx.listTeamMembers(targetSessionId)).toEqual([playerMember]);
      expect(await tx.listWinAwards(targetSessionId)).toEqual([playerAward, guestOwnerAward]);
      expect(await tx.listWinEvents(targetSessionId)).toEqual([targetEvent]);
    });
  });

  it('rejects attendance correction for a session that is not finished without changing its participants', async () => {
    const store = new InMemoryFootballStore();
    await seedSessions(store);
    await store.transact((tx) => tx.saveSession(session(targetSessionId, 'playing')));

    await expect(store.transact((tx) => tx.removeCompletedParticipant(targetSessionId, playerParticipant.participantId)))
      .rejects.toThrow('session is not finished');

    expect(await store.transact((tx) => tx.listParticipants(targetSessionId))).toEqual([
      playerParticipant,
      guestParticipant,
    ]);
  });

  it('rejects attendance correction for an absent participant without changing the completed session', async () => {
    const store = new InMemoryFootballStore();
    await seedSessions(store);

    await expect(store.transact((tx) => tx.removeCompletedParticipant(targetSessionId, 'missing-participant')))
      .rejects.toThrow('participant not found');

    await store.transact(async (tx) => {
      expect(await tx.listParticipants(targetSessionId)).toEqual([playerParticipant, guestParticipant]);
      expect(await tx.listTeamMembers(targetSessionId)).toEqual([playerMember, guestMember]);
      expect(await tx.listWinAwards(targetSessionId)).toEqual([playerAward, guestOwnerAward]);
    });
  });
});

async function seedSessions(store: InMemoryFootballStore): Promise<void> {
  await store.transact(async (tx) => {
    await tx.upsertPlayer({ telegramUserId: 'player-1', displayName: 'Player One' }, '2026-09-01T00:00:00.000Z');
    await tx.upsertPlayer({ telegramUserId: 'player-2', displayName: 'Player Two' }, '2026-09-01T00:00:00.000Z');
    await tx.saveSession({ ...session(targetSessionId, 'finished'), registrationMessageId: '11', scoreMessageId: '12' });
    await tx.saveSession(session(otherSessionId, 'finished'));
    await tx.replaceParticipants(targetSessionId, [playerParticipant, guestParticipant]);
    await tx.replaceParticipants(otherSessionId, [otherParticipant]);
    await tx.replaceTeams(targetSessionId, [{ sessionId: targetSessionId, teamNumber: 1 }], [playerMember, guestMember]);
    await tx.replaceTeams(otherSessionId, [{ sessionId: otherSessionId, teamNumber: 1 }], [otherMember]);
    await tx.appendWin(targetEvent, [playerAward, guestOwnerAward]);
    await tx.appendWin(otherEvent, [otherAward]);
    await tx.markScheduledAction(`${targetSessionId}:finish`, targetSessionId, 'finish', '2026-09-18T20:00:00.000Z');
    await tx.markScheduledAction(`${otherSessionId}:finish`, otherSessionId, 'finish', '2026-09-25T20:00:00.000Z');
    await tx.enqueue('target-effect', { kind: 'teams', sessionId: targetSessionId }, '2026-09-01T00:00:00.000Z');
    await tx.enqueue('other-effect', { kind: 'teams', sessionId: otherSessionId }, '2026-09-01T00:00:00.000Z');
  });
}

function session(sessionId: string, status: Session['status']): Session {
  return { sessionId, status, nextQueuePosition: 3n, nextWinOrdinal: 2n };
}

const playerParticipant: Participant = {
  participantId: 'player-participant', sessionId: targetSessionId, ownerUserId: 'player-1', telegramUserId: 'player-1',
  displayName: 'Player One', kind: 'player', queuePosition: 1n, rosterStatus: 'active',
};
const guestParticipant: Participant = {
  participantId: 'guest-participant', sessionId: targetSessionId, ownerUserId: 'player-2',
  displayName: 'Player Two guest', kind: 'guest', guestNumber: 1, queuePosition: 2n, rosterStatus: 'active',
};
const otherParticipant: Participant = {
  participantId: 'other-participant', sessionId: otherSessionId, ownerUserId: 'player-2', telegramUserId: 'player-2',
  displayName: 'Player Two', kind: 'player', queuePosition: 1n, rosterStatus: 'active',
};
const playerMember: TeamMember = { ...playerParticipant, teamNumber: 1, role: 'starter' };
const guestMember: TeamMember = { ...guestParticipant, teamNumber: 1, role: 'starter' };
const otherMember: TeamMember = { ...otherParticipant, teamNumber: 1, role: 'starter' };
const targetEvent: WinEvent = {
  sessionId: targetSessionId, ordinal: 1n, teamNumber: 1, adminUserId: 'admin', createdAtIso: '2026-09-18T20:00:00.000Z',
};
const otherEvent: WinEvent = {
  sessionId: otherSessionId, ordinal: 1n, teamNumber: 1, adminUserId: 'admin', createdAtIso: '2026-09-25T20:00:00.000Z',
};
const playerAward: WinAward = {
  sessionId: targetSessionId, winOrdinal: 1n, telegramUserId: 'player-1', displayName: 'Player One',
};
const guestOwnerAward: WinAward = {
  sessionId: targetSessionId, winOrdinal: 1n, telegramUserId: 'player-2', displayName: 'Player Two',
};
const otherAward: WinAward = {
  sessionId: otherSessionId, winOrdinal: 1n, telegramUserId: 'player-2', displayName: 'Player Two',
};
