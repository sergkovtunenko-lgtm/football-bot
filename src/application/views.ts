import type { SessionStatus, Team } from '../domain/model';

export interface NamedParticipantView { displayName: string; }
export interface RegistrationView {
  sessionId: string;
  active: readonly NamedParticipantView[];
  waitlist: readonly NamedParticipantView[];
  maxActive: 20;
}
export interface TeamView {
  teamNumber: Team['teamNumber'];
  starters: readonly NamedParticipantView[];
  reserves: readonly NamedParticipantView[];
}
export interface TeamsView { sessionId: string; teams: readonly TeamView[]; }
export interface ScoreView {
  sessionId: string;
  teams: readonly { teamNumber: Team['teamNumber']; wins: number }[];
  finished: boolean;
}
export interface DailyResultsView {
  sessionId: string;
  teams: readonly { teamNumber: Team['teamNumber']; wins: number }[];
  rows: readonly { displayName: string; wins: number }[];
}
export interface StatusView {
  sessionId: string;
  sessionStatus: SessionStatus;
  nextActionKind: 'open' | 'close';
  nextActionAtIso: string;
  activeCount: number;
  waitlistCount: number;
  teamCount: number;
  pendingEffectCount: number;
  lastSafeError?: string;
}
