import type { Participant, PlayerProfile, Session, Team, TeamMember, WinAward, WinEvent } from '../domain/model';

export type TelegramEffect =
  | { kind: 'registration_card'; sessionId: string }
  | { kind: 'promotion_notice'; sessionId: string; ownerUserId: string }
  | { kind: 'teams'; sessionId: string }
  | { kind: 'score_panel'; sessionId: string }
  | { kind: 'final_results'; sessionId: string }
  | { kind: 'admin_error'; correlationId: string; summary: string };
export type AdminErrorEffect = Extract<TelegramEffect, { kind: 'admin_error' }>;

export interface StoredEffect {
  effectId: string;
  effect: TelegramEffect;
  attempts: number;
  nextAttemptAtIso: string;
}

export interface BotSettings { groupChatId?: string; }
export interface OperationalStatus { pendingEffectCount: number; lastSafeError?: string; }

export interface FootballTransaction {
  getSettings(): Promise<BotSettings>;
  saveSettings(settings: BotSettings): Promise<void>;
  upsertPlayer(player: PlayerProfile, nowIso: string): Promise<void>;
  listPlayers(): Promise<PlayerProfile[]>;
  getSession(sessionId: string): Promise<Session | undefined>;
  saveSession(session: Session): Promise<void>;
  listParticipants(sessionId: string): Promise<Participant[]>;
  replaceParticipants(sessionId: string, participants: readonly Participant[]): Promise<void>;
  listTeams(sessionId: string): Promise<Team[]>;
  listTeamMembers(sessionId: string): Promise<TeamMember[]>;
  replaceTeams(sessionId: string, teams: readonly Team[], members: readonly TeamMember[]): Promise<void>;
  listWinEvents(sessionId?: string): Promise<WinEvent[]>;
  listWinAwards(sessionId?: string): Promise<WinAward[]>;
  appendWin(event: WinEvent, awards: readonly WinAward[]): Promise<void>;
  reverseWin(sessionId: string, ordinal: bigint, reversedAtIso: string): Promise<void>;
  listCompletedSessionIds(): Promise<Set<string>>;
  hasScheduledAction(actionKey: string): Promise<boolean>;
  markScheduledAction(actionKey: string, sessionId: string, kind: string, executedAtIso: string): Promise<void>;
  enqueue(effectId: string, effect: TelegramEffect, nowIso: string): Promise<void>;
}

export interface UpdateExecution<T> { duplicate: boolean; value?: T; }

export interface FootballStore {
  transact<T>(work: (tx: FootballTransaction) => Promise<T>): Promise<T>;
  transactUpdate<T>(updateId: string, nowIso: string, work: (tx: FootballTransaction) => Promise<T>): Promise<UpdateExecution<T>>;
  claimDueEffects(nowIso: string, limit: number, leaseId: string): Promise<StoredEffect[]>;
  markEffectSent(effectId: string, sentAtIso: string): Promise<void>;
  rescheduleEffect(effectId: string, attempts: number, nextAttemptAtIso: string, safeError: string): Promise<void>;
  rescheduleEffectWithNotice(
    effectId: string,
    attempts: number,
    nextAttemptAtIso: string,
    safeError: string,
    noticeEffectId: string,
    notice: AdminErrorEffect,
    noticeAtIso: string,
  ): Promise<void>;
  markEffectPermanentlyFailed(effectId: string, failedAtIso: string, safeError: string): Promise<void>;
  getOperationalStatus(): Promise<OperationalStatus>;
}
