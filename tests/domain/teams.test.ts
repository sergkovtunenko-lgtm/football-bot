import { describe, expect, it } from 'vitest';
import { formTeams } from '../../src/domain/teams';
import type { Participant } from '../../src/domain/model';

const participants = (count: number): Participant[] => Array.from({ length: count }, (_, i) => ({
  participantId: `p${i + 1}`,
  sessionId: '2026-07-24',
  ownerUserId: String(i + 1),
  telegramUserId: String(i + 1),
  displayName: `P${i + 1}`,
  kind: 'player',
  queuePosition: BigInt(i + 1),
  rosterStatus: 'active',
}));
const zeroRandom = { int: () => 0 };

describe('formTeams', () => {
  it.each([[0, 0], [5, 0], [6, 2], [9, 2], [10, 2], [11, 3], [14, 3], [15, 3], [16, 4], [19, 4], [20, 4]])(
    'forms %i participants into %i teams',
    (count, expectedTeams) => {
      expect(formTeams(participants(count), zeroRandom).teams).toHaveLength(expectedTeams);
    },
  );

  it('creates a separate incomplete team instead of reserves for 18 participants', () => {
    const result = formTeams(participants(18), zeroRandom);
    expect(result.teams).toHaveLength(4);
    expect(result.teams.map((team) => result.members.filter((member) => member.teamNumber === team.teamNumber))).toHaveLength(4);
    expect(result.teams.map((team) => result.members.filter((member) => member.teamNumber === team.teamNumber).length))
      .toEqual([5, 5, 5, 3]);
    expect(result.members.every((member) => member.role === 'starter')).toBe(true);
    expect(new Set(result.members.map((m) => m.participantId)).size).toBe(18);
  });

  it('ignores waitlisted participants', () => {
    const list = participants(20);
    list.push({ ...participants(1)[0]!, participantId: 'wait', queuePosition: 21n, rosterStatus: 'waitlist' });
    expect(formTeams(list, zeroRandom).members.some((m) => m.participantId === 'wait')).toBe(false);
  });

  it('rejects a random source index outside the shuffle range', () => {
    expect(() => formTeams(participants(10), { int: () => -1 })).toThrow(
      'RandomSource returned an invalid index',
    );
  });

  it.each([21, 22, 23, 24, 25])('uses exactly the first 20 eligible participants for %i active inputs', (count) => {
    const result = formTeams(participants(count), zeroRandom);
    expect(new Set(result.members.map((member) => member.participantId))).toEqual(
      new Set(participants(20).map((participant) => participant.participantId)),
    );
  });

  it('maintains formation invariants for 50 deterministic shuffle sequences', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      let state = seed + 1;
      const random = {
        int(maxExclusive: number) {
          state = (state * 1664525 + 1013904223) >>> 0;
          return state % maxExclusive;
        },
      };

      for (let count = 0; count <= 25; count += 1) {
        const active = participants(count);
        const waitlisted = { ...participants(1)[0]!, participantId: `wait-${seed}-${count}`, rosterStatus: 'waitlist' as const };
        const result = formTeams([...active, waitlisted], random);
        const selectedCount = Math.min(count, 20);
        expect(result.teams).toHaveLength(selectedCount < 6 ? 0 : Math.ceil(selectedCount / 5));
        expect(result.members.some((member) => member.participantId === waitlisted.participantId)).toBe(false);
        expect(new Set(result.members.map((member) => member.participantId)).size).toBe(result.members.length);
        expect(result.members).toHaveLength(selectedCount < 6 ? 0 : selectedCount);

        const teamSizes = result.teams.map((team) => {
          const members = result.members.filter((member) => member.teamNumber === team.teamNumber);
          expect(members.every((member) => member.role === 'starter')).toBe(true);
          return members.length;
        });
        if (teamSizes.length > 0) {
          expect(teamSizes.slice(0, -1)).toEqual(Array(teamSizes.length - 1).fill(5));
          expect(teamSizes.at(-1)).toBeGreaterThanOrEqual(1);
          expect(teamSizes.at(-1)).toBeLessThanOrEqual(5);
        }
      }
    }
  });
});
