import { describe, expect, it } from 'vitest';
import { changeParty, type RegistrationState } from '../../src/domain/registration';

const player = { telegramUserId: '111', displayName: 'Иван', username: 'ivan' };
const empty: RegistrationState = { sessionId: '2026-07-24', participants: [], nextQueuePosition: 1n };

function expectValidQueue(state: RegistrationState) {
  const positions = state.participants.map((participant) => participant.queuePosition);
  expect(new Set(positions).size).toBe(positions.length);
  expect(positions.every((position) => position > 0n)).toBe(true);
}

describe('changeParty', () => {
  it('creates the player and two separately queued guests', () => {
    const result = changeParty(empty, { player, partySize: 3 }, ['p1', 'g1', 'g2']);
    expect(result.participants.map((p) => [p.participantId, p.kind, p.queuePosition])).toEqual([
      ['p1', 'player', 1n], ['g1', 'guest', 2n], ['g2', 'guest', 3n],
    ]);
    expect(result.nextQueuePosition).toBe(4n);
  });

  it('keeps the player position and appends a newly added guest', () => {
    const one = changeParty(empty, { player, partySize: 1 }, ['p1']);
    const two = changeParty(one, { player, partySize: 2 }, ['g1']);
    expect(two.participants.map((p) => p.queuePosition)).toEqual([1n, 2n]);
  });

  it('removes the newest guest first and retains the player', () => {
    const three = changeParty(empty, { player, partySize: 3 }, ['p1', 'g1', 'g2']);
    const two = changeParty(three, { player, partySize: 2 }, []);
    expect(two.participants.map((p) => p.participantId)).toEqual(['p1', 'g1']);
  });

  it('places slots 21 and 22 in FIFO waitlist and promotes them after cancellation', () => {
    let state = empty;
    for (let i = 1; i <= 22; i += 1) {
      state = changeParty(
        state,
        { player: { telegramUserId: String(i), displayName: `P${i}` }, partySize: 1 },
        [`p${i}`],
      );
    }
    expect(state.participants.filter((p) => p.rosterStatus === 'active')).toHaveLength(20);
    expect(state.participants.find((p) => p.participantId === 'p21')?.rosterStatus).toBe('waitlist');
    const cancellation = changeParty(
      state,
      { player: { telegramUserId: '1', displayName: 'P1' }, partySize: 0 },
      [],
    );
    expect(cancellation.participants.find((p) => p.participantId === 'p21')?.rosterStatus).toBe('active');
    expect(cancellation.promotedOwnerIds).toEqual(['21']);
  });

  it('handles party-size transitions without changing retained positions', () => {
    const cases = [
      {
        name: '+ to +1 to +2',
        commands: [
          { partySize: 1 as const, ids: ['p1'] },
          { partySize: 2 as const, ids: ['g1'] },
          { partySize: 3 as const, ids: ['g2'] },
        ],
        participantIds: ['p1', 'g1', 'g2'],
        positions: [1n, 2n, 3n],
      },
      {
        name: '+2 to +',
        commands: [
          { partySize: 3 as const, ids: ['p1', 'g1', 'g2'] },
          { partySize: 1 as const, ids: [] },
        ],
        participantIds: ['p1'],
        positions: [1n],
      },
      {
        name: 'full cancellation',
        commands: [
          { partySize: 3 as const, ids: ['p1', 'g1', 'g2'] },
          { partySize: 0 as const, ids: [] },
        ],
        participantIds: [],
        positions: [],
      },
    ];

    for (const testCase of cases) {
      let state = empty;
      for (const command of testCase.commands) {
        state = changeParty(state, { player, partySize: command.partySize }, command.ids);
        expectValidQueue(state);
      }
      expect(state.participants.map((participant) => participant.participantId)).toEqual(testCase.participantIds);
      expect(state.participants.map((participant) => participant.queuePosition)).toEqual(testCase.positions);
    }
  });

  it('re-registers after cancellation at the queue tail', () => {
    const joined = changeParty(empty, { player, partySize: 1 }, ['p1']);
    const cancelled = changeParty(joined, { player, partySize: 0 }, []);
    const registeredAgain = changeParty(cancelled, { player, partySize: 1 }, ['p2']);

    expectValidQueue(joined);
    expectValidQueue(cancelled);
    expectValidQueue(registeredAgain);
    expect(registeredAgain.participants.map((participant) => [participant.participantId, participant.queuePosition]))
      .toEqual([['p2', 2n]]);
  });

  it('splits a party across active and waitlist slots', () => {
    let state = empty;
    for (let i = 1; i <= 19; i += 1) {
      state = changeParty(
        state,
        { player: { telegramUserId: String(i), displayName: `P${i}` }, partySize: 1 },
        [`p${i}`],
      );
      expectValidQueue(state);
    }
    state = changeParty(
      state,
      { player: { telegramUserId: '20', displayName: 'P20' }, partySize: 3 },
      ['p20', 'g20-1', 'g20-2'],
    );

    expectValidQueue(state);
    expect(state.participants.slice(-3).map((participant) => [participant.queuePosition, participant.rosterStatus]))
      .toEqual([[20n, 'active'], [21n, 'waitlist'], [22n, 'waitlist']]);
  });

  it('clamps a minus-two change to the player-only application', () => {
    const three = changeParty(empty, { player, partySize: 3 }, ['p1', 'g1', 'g2']);
    const one = changeParty(three, { player, partySize: 1 }, []);

    expectValidQueue(three);
    expectValidQueue(one);
    expect(one.participants.map((participant) => [participant.participantId, participant.kind, participant.queuePosition]))
      .toEqual([['p1', 'player', 1n]]);
  });

  it('refreshes retained display names without changing their queue positions', () => {
    const three = changeParty(empty, { player, partySize: 3 }, ['p1', 'g1', 'g2']);
    const renamed = changeParty(
      three,
      { player: { telegramUserId: player.telegramUserId, displayName: 'Пётр' }, partySize: 3 },
      [],
    );

    expectValidQueue(renamed);
    expect(renamed.participants.map((participant) => [participant.displayName, participant.queuePosition])).toEqual([
      ['Пётр', 1n],
      ['Гость 1 — от Пётр', 2n],
      ['Гость 2 — от Пётр', 3n],
    ]);
  });
});
