import type { Participant, PlayerProfile } from './model';

export interface RegistrationState {
  sessionId: string;
  participants: Participant[];
  nextQueuePosition: bigint;
}

export interface RegistrationCommand {
  player: PlayerProfile;
  partySize: 0 | 1 | 2 | 3;
}

export interface RegistrationChange extends RegistrationState {
  promotedOwnerIds: string[];
}

export function rebalanceRoster(participants: Participant[], maxActive = 20): Participant[] {
  return [...participants]
    .sort((a, b) => (a.queuePosition < b.queuePosition ? -1 : 1))
    .map((participant, index) => ({
      ...participant,
      rosterStatus: index < maxActive ? 'active' : 'waitlist',
    }));
}

export function changeParty(
  state: RegistrationState,
  command: RegistrationCommand,
  newParticipantIds: string[],
  maxActive = 20,
): RegistrationChange {
  if (!Number.isInteger(command.partySize) || command.partySize < 0 || command.partySize > 3) {
    throw new Error('partySize must be between 0 and 3');
  }

  const beforeWaitlist = new Set(
    state.participants.filter((p) => p.rosterStatus === 'waitlist').map((p) => p.participantId),
  );
  const owned = state.participants
    .filter((p) => p.ownerUserId === command.player.telegramUserId)
    .sort((a, b) => (a.queuePosition < b.queuePosition ? -1 : 1));
  const keep = owned.slice(0, command.partySize).map((participant) => {
    if (participant.kind === 'player') {
      return { ...participant, displayName: command.player.displayName };
    }
    return {
      ...participant,
      displayName: `Гость ${participant.guestNumber} — от ${command.player.displayName}`,
    };
  });
  const unrelated = state.participants.filter((p) => p.ownerUserId !== command.player.telegramUserId);
  let next = state.nextQueuePosition;
  let idIndex = 0;

  while (keep.length < command.partySize) {
    const participantId = newParticipantIds[idIndex++]!;
    if (keep.length === 0) {
      keep.push({
        participantId,
        sessionId: state.sessionId,
        ownerUserId: command.player.telegramUserId,
        telegramUserId: command.player.telegramUserId,
        displayName: command.player.displayName,
        kind: 'player',
        queuePosition: next++,
        rosterStatus: 'waitlist',
      });
    } else {
      const guestNumber = keep.length as 1 | 2;
      keep.push({
        participantId,
        sessionId: state.sessionId,
        ownerUserId: command.player.telegramUserId,
        displayName: `Гость ${guestNumber} — от ${command.player.displayName}`,
        kind: 'guest',
        guestNumber,
        queuePosition: next++,
        rosterStatus: 'waitlist',
      });
    }
  }

  const rebalanced = rebalanceRoster([...unrelated, ...keep], maxActive);
  const promotedOwnerIds = [...new Set(rebalanced
    .filter((p) => p.rosterStatus === 'active' && beforeWaitlist.has(p.participantId))
    .map((p) => p.ownerUserId))];

  return {
    sessionId: state.sessionId,
    participants: rebalanced,
    nextQueuePosition: next,
    promotedOwnerIds,
  };
}
