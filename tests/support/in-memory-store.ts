import type {
  BotSettings,
  AdminErrorEffect,
  FootballStore,
  FootballTransaction,
  OperationalStatus,
  StoredEffect,
  TelegramEffect,
  UpdateExecution,
} from '../../src/ports/store';
import type { Participant, PlayerProfile, Session, Team, TeamMember, WinAward, WinEvent } from '../../src/domain/model';

interface EffectRecord extends StoredEffect {
  leaseId?: string;
  leaseExpiresAtIso?: string;
  sentAtIso?: string;
  failedAtIso?: string;
}

interface State {
  settings: BotSettings;
  players: Map<string, PlayerProfile>;
  sessions: Map<string, Session>;
  participants: Map<string, Participant[]>;
  teams: Map<string, Team[]>;
  members: Map<string, TeamMember[]>;
  winEvents: Map<string, WinEvent>;
  winAwards: Map<string, WinAward>;
  scheduledActions: Map<string, { sessionId: string; kind: string; executedAtIso: string }>;
  effects: Map<string, EffectRecord>;
  processedUpdates: Set<string>;
  lastSafeError?: string;
}

const LEASE_MILLISECONDS = 30_000;

export class InMemoryFootballStore implements FootballStore {
  private state: State = emptyState();
  private queue: Promise<void> = Promise.resolve();
  private rejectNextEnqueue = false;
  private rejectNextReschedule = false;
  private rejectConcurrentTransactionAccess = false;

  transact<T>(work: (tx: FootballTransaction) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const clone = structuredClone(this.state);
      const tx = this.transaction(clone);
      const result = await work(this.rejectConcurrentTransactionAccess ? concurrencyGuard(tx) : tx);
      this.state = clone;
      return result;
    });
  }

  transactUpdate<T>(
    updateId: string,
    _nowIso: string,
    work: (tx: FootballTransaction) => Promise<T>,
  ): Promise<UpdateExecution<T>> {
    return this.serialized(async () => {
      if (this.state.processedUpdates.has(updateId)) return { duplicate: true };
      const clone = structuredClone(this.state);
      const tx = this.transaction(clone);
      const value = await work(this.rejectConcurrentTransactionAccess ? concurrencyGuard(tx) : tx);
      clone.processedUpdates.add(updateId);
      this.state = clone;
      return { duplicate: false, value };
    });
  }

  claimDueEffects(nowIso: string, limit: number, leaseId: string): Promise<StoredEffect[]> {
    return this.serialized(async () => {
      const leaseExpiresAtIso = new Date(new Date(nowIso).getTime() + LEASE_MILLISECONDS).toISOString();
      const claimed = [...this.state.effects.values()]
        .filter((effect) => !effect.sentAtIso && !effect.failedAtIso)
        .filter((effect) => effect.nextAttemptAtIso <= nowIso)
        .filter((effect) => !effect.leaseExpiresAtIso || effect.leaseExpiresAtIso <= nowIso)
        .slice(0, Math.max(0, limit));
      for (const effect of claimed) {
        effect.leaseId = leaseId;
        effect.leaseExpiresAtIso = leaseExpiresAtIso;
      }
      return claimed.map(storedEffect);
    });
  }

  markEffectSent(effectId: string, sentAtIso: string): Promise<void> {
    return this.serialized(async () => {
      const effect = this.requiredEffect(effectId);
      effect.sentAtIso = sentAtIso;
      delete effect.leaseId;
      delete effect.leaseExpiresAtIso;
    });
  }

  rescheduleEffect(effectId: string, attempts: number, nextAttemptAtIso: string, safeError: string): Promise<void> {
    return this.serialized(async () => {
      if (this.rejectNextReschedule) {
        this.rejectNextReschedule = false;
        throw new Error('injected reschedule failure');
      }
      const effect = this.requiredEffect(effectId);
      effect.attempts = attempts;
      effect.nextAttemptAtIso = nextAttemptAtIso;
      delete effect.leaseId;
      delete effect.leaseExpiresAtIso;
      this.state.lastSafeError = safeError;
    });
  }

  rescheduleEffectWithNotice(
    effectId: string,
    attempts: number,
    nextAttemptAtIso: string,
    safeError: string,
    noticeEffectId: string,
    notice: AdminErrorEffect,
    noticeAtIso: string,
  ): Promise<void> {
    return this.serialized(async () => {
      const clone = structuredClone(this.state);
      const effect = clone.effects.get(effectId);
      if (!effect) throw new Error(`effect not found: ${effectId}`);
      if (!clone.effects.has(noticeEffectId)) {
        if (this.rejectNextEnqueue) {
          this.rejectNextEnqueue = false;
          throw new Error('injected enqueue failure');
        }
        clone.effects.set(noticeEffectId, {
          effectId: noticeEffectId,
          effect: structuredClone(notice),
          attempts: 0,
          nextAttemptAtIso: noticeAtIso,
        });
      }
      if (this.rejectNextReschedule) {
        this.rejectNextReschedule = false;
        throw new Error('injected reschedule failure');
      }
      effect.attempts = attempts;
      effect.nextAttemptAtIso = nextAttemptAtIso;
      delete effect.leaseId;
      delete effect.leaseExpiresAtIso;
      clone.lastSafeError = safeError;
      this.state = clone;
    });
  }

  markEffectPermanentlyFailed(effectId: string, failedAtIso: string, safeError: string): Promise<void> {
    return this.serialized(async () => {
      const effect = this.requiredEffect(effectId);
      effect.failedAtIso = failedAtIso;
      delete effect.leaseId;
      delete effect.leaseExpiresAtIso;
      this.state.lastSafeError = safeError;
    });
  }

  getOperationalStatus(): Promise<OperationalStatus> {
    return this.serialized(async () => {
      const pendingEffectCount = [...this.state.effects.values()]
        .filter((effect) => !effect.sentAtIso && !effect.failedAtIso).length;
      return this.state.lastSafeError
        ? { pendingEffectCount, lastSafeError: this.state.lastSafeError }
        : { pendingEffectCount };
    });
  }

  pendingEffects(): StoredEffect[] {
    return [...this.state.effects.values()]
      .filter((effect) => !effect.sentAtIso && !effect.failedAtIso)
      .map(storedEffect);
  }

  scheduledActionKeys(): string[] {
    return [...this.state.scheduledActions.keys()].sort();
  }

  failNextEnqueue(): void {
    this.rejectNextEnqueue = true;
  }

  failNextReschedule(): void {
    this.rejectNextReschedule = true;
  }

  rejectConcurrentTransactionCalls(): void {
    this.rejectConcurrentTransactionAccess = true;
  }

  private transaction(state: State): FootballTransaction {
    return {
      getSettings: async () => structuredClone(state.settings),
      saveSettings: async (settings) => { state.settings = structuredClone(settings); },
      upsertPlayer: async (player, _nowIso) => { state.players.set(player.telegramUserId, structuredClone(player)); },
      listPlayers: async () => structuredClone([...state.players.values()]),
      getSession: async (sessionId) => structuredClone(state.sessions.get(sessionId)),
      saveSession: async (session) => { state.sessions.set(session.sessionId, structuredClone(session)); },
      listParticipants: async (sessionId) => structuredClone(state.participants.get(sessionId) ?? []),
      replaceParticipants: async (sessionId, participants) => {
        state.participants.set(sessionId, structuredClone([...participants]));
      },
      listTeams: async (sessionId) => structuredClone(state.teams.get(sessionId) ?? []),
      listTeamMembers: async (sessionId) => structuredClone(state.members.get(sessionId) ?? []),
      replaceTeams: async (sessionId, teams, members) => {
        state.teams.set(sessionId, structuredClone([...teams]));
        state.members.set(sessionId, structuredClone([...members]));
      },
      listWinEvents: async (sessionId) => structuredClone([...state.winEvents.values()]
        .filter((event) => !sessionId || event.sessionId === sessionId)),
      listWinAwards: async (sessionId) => structuredClone([...state.winAwards.values()]
        .filter((award) => !sessionId || award.sessionId === sessionId)),
      appendWin: async (event, awards) => {
        const eventKey = `${event.sessionId}:${event.ordinal}`;
        if (state.winEvents.has(eventKey)) throw new Error('duplicate win event');
        const awardKeys = awards.map((award) => `${award.sessionId}:${award.winOrdinal}:${award.telegramUserId}`);
        if (new Set(awardKeys).size !== awardKeys.length || awardKeys.some((key) => state.winAwards.has(key))) {
          throw new Error('duplicate win award');
        }
        state.winEvents.set(eventKey, structuredClone(event));
        awards.forEach((award, index) => state.winAwards.set(awardKeys[index]!, structuredClone(award)));
      },
      reverseWin: async (sessionId, ordinal, reversedAtIso) => {
        const key = `${sessionId}:${ordinal}`;
        const event = state.winEvents.get(key);
        if (!event) throw new Error('win event not found');
        state.winEvents.set(key, { ...event, reversedAtIso });
      },
      listCompletedSessionIds: async () => new Set([...state.sessions.values()]
        .filter((session) => session.status === 'finished').map((session) => session.sessionId)),
      hasScheduledAction: async (actionKey) => state.scheduledActions.has(actionKey),
      markScheduledAction: async (actionKey, sessionId, kind, executedAtIso) => {
        if (state.scheduledActions.has(actionKey)) throw new Error('duplicate scheduled action');
        state.scheduledActions.set(actionKey, { sessionId, kind, executedAtIso });
      },
      enqueue: async (effectId, effect, nowIso) => {
        if (this.rejectNextEnqueue) {
          this.rejectNextEnqueue = false;
          throw new Error('injected enqueue failure');
        }
        if (state.effects.has(effectId)) throw new Error('duplicate effect');
        state.effects.set(effectId, { effectId, effect: structuredClone(effect), attempts: 0, nextAttemptAtIso: nowIso });
      },
    };
  }

  private requiredEffect(effectId: string): EffectRecord {
    const effect = this.state.effects.get(effectId);
    if (!effect) throw new Error(`effect not found: ${effectId}`);
    return effect;
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function concurrencyGuard(transaction: FootballTransaction): FootballTransaction {
  let active = false;
  return new Proxy(transaction, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (active) throw new Error('concurrent transaction call');
        active = true;
        try {
          await Promise.resolve();
          return await Reflect.apply(value, target, args) as unknown;
        } finally {
          active = false;
        }
      };
    },
  }) as FootballTransaction;
}

function emptyState(): State {
  return {
    settings: {},
    players: new Map(),
    sessions: new Map(),
    participants: new Map(),
    teams: new Map(),
    members: new Map(),
    winEvents: new Map(),
    winAwards: new Map(),
    scheduledActions: new Map(),
    effects: new Map(),
    processedUpdates: new Set(),
  };
}

function storedEffect(record: EffectRecord): StoredEffect {
  return {
    effectId: record.effectId,
    effect: structuredClone(record.effect),
    attempts: record.attempts,
    nextAttemptAtIso: record.nextAttemptAtIso,
  };
}
