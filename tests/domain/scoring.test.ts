import { describe, expect, it } from 'vitest';
import {
  awardsForWin,
  buildLeaderboard,
  dailyPlayerWins,
  lastReversibleWin,
} from '../../src/domain/scoring';
import type { TeamMember, WinAward, WinEvent } from '../../src/domain/model';

const member = (id: string, role: 'starter' | 'reserve' = 'starter'): TeamMember => ({
  participantId: id,
  sessionId: '2026-07-24',
  ownerUserId: id,
  telegramUserId: id,
  displayName: `P${id}`,
  kind: 'player',
  queuePosition: BigInt(id),
  rosterStatus: 'active',
  teamNumber: 1,
  role,
});

describe('awardsForWin', () => {
  it('awards starters and team reserves but excludes guests', () => {
    const guest: TeamMember = {
      participantId: 'g', sessionId: '2026-07-24', ownerUserId: '9', displayName: 'Гость',
      kind: 'guest', guestNumber: 1, queuePosition: 9n, rosterStatus: 'active',
      teamNumber: 1, role: 'starter',
    };

    expect(awardsForWin('2026-07-24', 1n, [member('1'), member('2', 'reserve'), guest]))
      .toEqual([
        { sessionId: '2026-07-24', winOrdinal: 1n, telegramUserId: '1', displayName: 'P1' },
        { sessionId: '2026-07-24', winOrdinal: 1n, telegramUserId: '2', displayName: 'P2' },
      ]);
  });
});

describe('lastReversibleWin', () => {
  it('returns the greatest non-reversed ordinal', () => {
    const events: WinEvent[] = [
      { sessionId: 's', ordinal: 1n, teamNumber: 1, adminUserId: 'a', createdAtIso: '2026-01-01T00:00:00Z' },
      { sessionId: 's', ordinal: 2n, teamNumber: 2, adminUserId: 'a', createdAtIso: '2026-01-01T00:01:00Z', reversedAtIso: '2026-01-01T00:02:00Z' },
      { sessionId: 's', ordinal: 3n, teamNumber: 1, adminUserId: 'a', createdAtIso: '2026-01-01T00:03:00Z' },
    ];

    expect(lastReversibleWin(events)?.ordinal).toBe(3n);
  });
});

describe('dailyPlayerWins', () => {
  it('counts each active award and excludes reversed wins', () => {
    const events: WinEvent[] = [
      { sessionId: 's', ordinal: 1n, teamNumber: 1, adminUserId: 'a', createdAtIso: 'x' },
      { sessionId: 's', ordinal: 2n, teamNumber: 1, adminUserId: 'a', createdAtIso: 'x' },
      { sessionId: 's', ordinal: 3n, teamNumber: 2, adminUserId: 'a', createdAtIso: 'x', reversedAtIso: 'y' },
    ];
    const awards: WinAward[] = [
      { sessionId: 's', winOrdinal: 1n, telegramUserId: '1', displayName: 'Антон' },
      { sessionId: 's', winOrdinal: 1n, telegramUserId: '2', displayName: 'Борис' },
      { sessionId: 's', winOrdinal: 2n, telegramUserId: '1', displayName: 'Антон' },
      { sessionId: 's', winOrdinal: 3n, telegramUserId: '1', displayName: 'Антон' },
    ];

    expect(dailyPlayerWins('s', events, awards)).toEqual(new Map([['1', 2], ['2', 1]]));
  });
});

describe('buildLeaderboard', () => {
  it('counts only active awards from completed sessions and ranks 1, 1, 3', () => {
    const events: WinEvent[] = [
      { sessionId: 'done', ordinal: 1n, teamNumber: 1, adminUserId: 'a', createdAtIso: 'x' },
      { sessionId: 'done', ordinal: 2n, teamNumber: 1, adminUserId: 'a', createdAtIso: 'x' },
      { sessionId: 'open', ordinal: 1n, teamNumber: 1, adminUserId: 'a', createdAtIso: 'x' },
    ];
    const awards: WinAward[] = [
      { sessionId: 'done', winOrdinal: 1n, telegramUserId: '1', displayName: 'Антон' },
      { sessionId: 'done', winOrdinal: 1n, telegramUserId: '2', displayName: 'Борис' },
      { sessionId: 'done', winOrdinal: 1n, telegramUserId: '3', displayName: 'Виктор' },
      { sessionId: 'done', winOrdinal: 2n, telegramUserId: '1', displayName: 'Антон' },
      { sessionId: 'done', winOrdinal: 2n, telegramUserId: '2', displayName: 'Борис' },
      { sessionId: 'open', winOrdinal: 1n, telegramUserId: '1', displayName: 'Антон' },
    ];

    expect(buildLeaderboard(events, awards, new Set(['done']), new Map([['1', 'Антон Новый']]))).toEqual([
      { rank: 1, telegramUserId: '1', displayName: 'Антон Новый', wins: 2 },
      { rank: 1, telegramUserId: '2', displayName: 'Борис', wins: 2 },
      { rank: 3, telegramUserId: '3', displayName: 'Виктор', wins: 1 },
    ]);
  });
});
