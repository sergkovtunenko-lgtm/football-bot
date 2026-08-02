import type { Clock } from '../ports/clock';
import type { RandomSource } from '../ports/random';
import type { FootballStore, FootballTransaction, UpdateExecution } from '../ports/store';
import type { PlayerProfile, Session } from '../domain/model';
import { changeParty, type RegistrationChange } from '../domain/registration';
import { formTeams } from '../domain/teams';
import { awardsForWin, buildLeaderboard, lastReversibleWin, type LeaderboardRow } from '../domain/scoring';
import { nextScheduleAction, sessionIdForCurrentCycle } from '../domain/schedule';
import type { RegistrationView, StatusView } from './views';

export class ForbiddenError extends Error {}
export class InvalidStateError extends Error {}
export class NotFoundError extends Error {}

interface CloseResult { sessionId: string; teamCount: number; }

export class BotService {
  constructor(
    private readonly store: FootballStore,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly adminIds: ReadonlySet<string>,
    private readonly newId: () => string,
  ) {}

  setup(updateId: string, actorUserId: string, chatId: string): Promise<UpdateExecution<void>> {
    const nowIso = this.clock.now().toISOString();
    return this.store.transactUpdate(updateId, nowIso, async (tx) => {
      this.requireAdmin(actorUserId);
      await tx.saveSettings({ groupChatId: chatId });
    });
  }

  openNow(updateId: string, actorUserId: string): Promise<UpdateExecution<{ sessionId: string }>> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const sessionId = sessionIdForCurrentCycle(now);
    return this.store.transactUpdate(updateId, nowIso, async (tx) => {
      this.requireAdmin(actorUserId);
      const existing = await tx.getSession(sessionId);
      if (existing && existing.status !== 'scheduled') throw new InvalidStateError('session cannot be opened');
      await tx.saveSession(openSession(sessionId));
      await tx.enqueue(this.newId(), { kind: 'registration_card', sessionId }, nowIso);
      return { sessionId };
    });
  }

  remindNow(updateId: string, actorUserId: string): Promise<UpdateExecution<{ sessionId: string }>> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const sessionId = sessionIdForCurrentCycle(now);
    return this.store.transactUpdate(updateId, nowIso, async (tx) => {
      this.requireAdmin(actorUserId);
      const session = await this.requireSession(tx, sessionId);
      if (session.status !== 'registration_open') throw new InvalidStateError('registration is not open');
      await tx.enqueue(this.newId(), {
        kind: 'reminder',
        sessionId,
        actionKey: `manual:${updateId}`,
      }, nowIso);
      return { sessionId };
    });
  }

  setParty(
    updateId: string,
    player: PlayerProfile,
    partySize: 0 | 1 | 2 | 3,
  ): Promise<UpdateExecution<RegistrationChange>> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const sessionId = sessionIdForCurrentCycle(now);
    return this.store.transactUpdate(updateId, nowIso, async (tx) => {
      const session = await this.requireSession(tx, sessionId);
      if (session.status !== 'registration_open') throw new InvalidStateError('registration is not open');
      await tx.upsertPlayer(player, nowIso);
      const participants = await tx.listParticipants(sessionId);
      const ownedCount = participants.filter((participant) => participant.ownerUserId === player.telegramUserId).length;
      const participantIds = Array.from({ length: Math.max(0, partySize - ownedCount) }, () => this.newId());
      const change = changeParty({
        sessionId,
        participants,
        nextQueuePosition: session.nextQueuePosition,
      }, { player, partySize }, participantIds);
      await tx.replaceParticipants(sessionId, change.participants);
      await tx.saveSession({ ...session, nextQueuePosition: change.nextQueuePosition });
      await tx.enqueue(this.newId(), { kind: 'registration_card', sessionId }, nowIso);
      for (const ownerUserId of change.promotedOwnerIds) {
        await tx.enqueue(this.newId(), { kind: 'promotion_notice', sessionId, ownerUserId }, nowIso);
      }
      return change;
    });
  }

  closeNow(updateId: string, actorUserId: string): Promise<UpdateExecution<CloseResult>> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const sessionId = sessionIdForCurrentCycle(now);
    return this.store.transactUpdate(updateId, nowIso, async (tx) => {
      this.requireAdmin(actorUserId);
      return closeSession(tx, sessionId, nowIso, this.random, this.newId);
    });
  }

  recordWin(
    updateId: string,
    actorUserId: string,
    teamNumber: 1 | 2 | 3 | 4,
  ): Promise<UpdateExecution<{ ordinal: bigint }>> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const sessionId = sessionIdForCurrentCycle(now);
    return this.store.transactUpdate(updateId, nowIso, async (tx) => {
      this.requireAdmin(actorUserId);
      const session = await this.requireSession(tx, sessionId);
      if (session.status !== 'playing') throw new InvalidStateError('session is not playing');
      const teams = await tx.listTeams(sessionId);
      if (!teams.some((team) => team.teamNumber === teamNumber)) throw new NotFoundError('team not found');
      const ordinal = session.nextWinOrdinal;
      const members = (await tx.listTeamMembers(sessionId)).filter((member) => member.teamNumber === teamNumber);
      const event = { sessionId, ordinal, teamNumber, adminUserId: actorUserId, createdAtIso: nowIso };
      await tx.appendWin(event, awardsForWin(sessionId, ordinal, members));
      await tx.saveSession({ ...session, nextWinOrdinal: ordinal + 1n });
      await tx.enqueue(this.newId(), { kind: 'score_panel', sessionId }, nowIso);
      return { ordinal };
    });
  }

  undoLastWin(updateId: string, actorUserId: string): Promise<UpdateExecution<{ reversedOrdinal?: bigint }>> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const sessionId = sessionIdForCurrentCycle(now);
    return this.store.transactUpdate(updateId, nowIso, async (tx) => {
      this.requireAdmin(actorUserId);
      const session = await this.requireSession(tx, sessionId);
      if (session.status !== 'playing') throw new InvalidStateError('session is not playing');
      const latest = lastReversibleWin(await tx.listWinEvents(sessionId));
      if (!latest) return {};
      await tx.reverseWin(sessionId, latest.ordinal, nowIso);
      await tx.enqueue(this.newId(), { kind: 'score_panel', sessionId }, nowIso);
      return { reversedOrdinal: latest.ordinal };
    });
  }

  finish(updateId: string, actorUserId: string): Promise<UpdateExecution<{ leaderboard: LeaderboardRow[] }>> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const sessionId = sessionIdForCurrentCycle(now);
    return this.store.transactUpdate(updateId, nowIso, async (tx) => {
      this.requireAdmin(actorUserId);
      const session = await this.requireSession(tx, sessionId);
      if (!['playing', 'registration_closed', 'finished'].includes(session.status)) {
        throw new InvalidStateError('session cannot be finished');
      }
      if (session.status !== 'finished') await tx.saveSession({ ...session, status: 'finished' });
      const leaderboard = await completedLeaderboard(tx);
      if (session.status !== 'finished') {
        await tx.enqueue(this.newId(), { kind: 'final_results', sessionId }, nowIso);
      }
      return { leaderboard };
    });
  }

  async getPartySize(telegramUserId: string): Promise<0 | 1 | 2 | 3> {
    const sessionId = sessionIdForCurrentCycle(this.clock.now());
    const count = await this.store.transact(async (tx) => (await tx.listParticipants(sessionId))
      .filter((participant) => participant.ownerUserId === telegramUserId).length);
    return Math.min(3, count) as 0 | 1 | 2 | 3;
  }

  registrationView(): Promise<RegistrationView> {
    const sessionId = sessionIdForCurrentCycle(this.clock.now());
    return this.store.transact(async (tx) => {
      const participants = (await tx.listParticipants(sessionId))
        .sort((a, b) => a.queuePosition < b.queuePosition ? -1 : a.queuePosition > b.queuePosition ? 1 : 0);
      return {
        sessionId,
        active: participants.filter((participant) => participant.rosterStatus === 'active')
          .map(({ displayName }) => ({ displayName })),
        waitlist: participants.filter((participant) => participant.rosterStatus === 'waitlist')
          .map(({ displayName }) => ({ displayName })),
        maxActive: 20,
      };
    });
  }

  async status(): Promise<StatusView> {
    const now = this.clock.now();
    const sessionId = sessionIdForCurrentCycle(now);
    const snapshot = await this.store.transact(async (tx) => {
      const session = await tx.getSession(sessionId);
      const participants = await tx.listParticipants(sessionId);
      const teams = await tx.listTeams(sessionId);
      return {
        sessionStatus: session?.status ?? 'scheduled' as const,
        activeCount: participants.filter((participant) => participant.rosterStatus === 'active').length,
        waitlistCount: participants.filter((participant) => participant.rosterStatus === 'waitlist').length,
        teamCount: teams.length,
      };
    });
    const operational = await this.store.getOperationalStatus();
    const next = nextScheduleAction(now, snapshot.sessionStatus);
    return operational.lastSafeError ? {
      sessionId,
      ...snapshot,
      nextActionKind: next.kind,
      nextActionAtIso: next.atIso,
      pendingEffectCount: operational.pendingEffectCount,
      lastSafeError: operational.lastSafeError,
    } : {
      sessionId,
      ...snapshot,
      nextActionKind: next.kind,
      nextActionAtIso: next.atIso,
      pendingEffectCount: operational.pendingEffectCount,
    };
  }

  private requireAdmin(actorUserId: string): void {
    if (!this.adminIds.has(actorUserId)) throw new ForbiddenError('administrator required');
  }

  private async requireSession(tx: FootballTransaction, sessionId: string): Promise<Session> {
    const session = await tx.getSession(sessionId);
    if (!session) throw new InvalidStateError('session does not exist');
    return session;
  }
}

export async function closeSession(
  tx: FootballTransaction,
  sessionId: string,
  nowIso: string,
  random: RandomSource,
  newId: () => string,
): Promise<CloseResult> {
  const session = await tx.getSession(sessionId);
  if (!session) throw new InvalidStateError('session does not exist');
  if (session.status !== 'registration_open') throw new InvalidStateError('registration is not open');
  const formation = formTeams(await tx.listParticipants(sessionId), random);
  await tx.replaceTeams(sessionId, formation.teams, formation.members);
  await tx.saveSession({ ...session, status: formation.teams.length >= 2 ? 'playing' : 'registration_closed' });
  await tx.enqueue(newId(), { kind: 'teams', sessionId }, nowIso);
  if (formation.teams.length >= 2) await tx.enqueue(newId(), { kind: 'score_panel', sessionId }, nowIso);
  return { sessionId, teamCount: formation.teams.length };
}

function openSession(sessionId: string): Session {
  return { sessionId, status: 'registration_open', nextQueuePosition: 1n, nextWinOrdinal: 1n };
}

async function completedLeaderboard(tx: FootballTransaction): Promise<LeaderboardRow[]> {
  const events = await tx.listWinEvents();
  const awards = await tx.listWinAwards();
  const completedSessionIds = await tx.listCompletedSessionIds();
  const players = await tx.listPlayers();
  return buildLeaderboard(
    events,
    awards,
    completedSessionIds,
    new Map(players.map((player) => [player.telegramUserId, player.displayName])),
  );
}
