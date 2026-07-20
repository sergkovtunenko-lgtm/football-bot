export type SessionStatus =
  | 'scheduled'
  | 'registration_open'
  | 'registration_closed'
  | 'playing'
  | 'finished';
export type ParticipantKind = 'player' | 'guest';
export type RosterStatus = 'active' | 'waitlist';
export type TeamRole = 'starter' | 'reserve';

export interface PlayerProfile {
  telegramUserId: string;
  displayName: string;
  username?: string;
}

export interface Session {
  sessionId: string;
  status: SessionStatus;
  nextQueuePosition: bigint;
  nextWinOrdinal: bigint;
  registrationMessageId?: string;
  scoreMessageId?: string;
}

export interface Participant {
  participantId: string;
  sessionId: string;
  ownerUserId: string;
  telegramUserId?: string;
  displayName: string;
  kind: ParticipantKind;
  guestNumber?: 1 | 2;
  queuePosition: bigint;
  rosterStatus: RosterStatus;
}

export interface Team {
  sessionId: string;
  teamNumber: 1 | 2 | 3 | 4;
}

export interface TeamMember extends Participant {
  teamNumber: Team['teamNumber'];
  role: TeamRole;
}

export interface WinEvent {
  sessionId: string;
  ordinal: bigint;
  teamNumber: Team['teamNumber'];
  adminUserId: string;
  createdAtIso: string;
  reversedAtIso?: string;
}

export interface WinAward {
  sessionId: string;
  winOrdinal: bigint;
  telegramUserId: string;
  displayName: string;
}
