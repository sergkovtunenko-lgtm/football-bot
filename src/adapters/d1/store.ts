import type { Participant, PlayerProfile, Session, Team, TeamMember, WinAward, WinEvent } from '../../domain/model';
import type { AdminErrorEffect, BotSettings, FootballStore, FootballTransaction, OperationalStatus,
  StoredEffect, TelegramEffect, UpdateExecution } from '../../ports/store';
import { redactTelegramTokens } from '../../security/redact';

export interface DatabaseStatement {
  bind(...values: unknown[]): DatabaseStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
export interface FootballDatabase {
  prepare(sql: string): DatabaseStatement;
  batch(statements: DatabaseStatement[]): Promise<{ meta: { changes: number } }[]>;
  exec(sql: string): Promise<unknown>;
}
export interface DatabaseRecord { kind: string; id: string; scope: string; status: string; payload: string; }
interface EffectRecord extends StoredEffect {
  status: 'pending' | 'leased' | 'sent' | 'failed';
  createdAtIso: string;
  leaseId?: string;
  leaseUntilIso?: string;
  sentAtIso?: string;
  failedAtIso?: string;
}

export function encodeRecord(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint'
    ? { $bigint: item.toString() } : item);
}
function decode<T>(json: string): T {
  return JSON.parse(json, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && '$bigint' in value
      && typeof value.$bigint === 'string') return BigInt(value.$bigint);
    return value;
  }) as T;
}

// The callback only stages database changes. A single D1 batch validates its read
// revision and commits all changes atomically; conflicts replay the callback.
export class D1FootballStore implements FootballStore {
  constructor(private readonly db: FootballDatabase) {}

  async transact<T>(work: (tx: FootballTransaction) => Promise<T>): Promise<T> {
    return this.execute(work);
  }

  async transactUpdate<T>(updateId: string, nowIso: string,
    work: (tx: FootballTransaction) => Promise<T>): Promise<UpdateExecution<T>> {
    return this.execute(async (tx) => {
      if (await tx.get('processed_updates', updateId)) return { duplicate: true };
      const value = await work(tx);
      tx.put('processed_updates', updateId, { processedAtIso: nowIso });
      return { duplicate: false, value };
    });
  }

  claimDueEffects(nowIso: string, limit: number, leaseId: string): Promise<StoredEffect[]> {
    if (limit <= 0) return Promise.resolve([]);
    return this.execute(async (tx) => {
      const effects = await tx.list<EffectRecord>('outbox', undefined, ['pending', 'leased']);
      // Payment must precede teams even during a retry or another worker's lease.
      const awaitingPayment = new Set(effects.flatMap(({ effect }) =>
        effect.kind === 'payment_notice' ? [effect.sessionId] : []));
      const due = effects.filter((effect) => effect.nextAttemptAtIso <= nowIso
        && (effect.status === 'pending' || !effect.leaseUntilIso || effect.leaseUntilIso <= nowIso)
        && !((effect.effect.kind === 'teams' || effect.effect.kind === 'score_panel')
          && awaitingPayment.has(effect.effect.sessionId)))
        .sort((a, b) => a.nextAttemptAtIso.localeCompare(b.nextAttemptAtIso)
          || a.createdAtIso.localeCompare(b.createdAtIso)
          || Number(b.effect.kind === 'payment_notice') - Number(a.effect.kind === 'payment_notice')
          || a.effectId.localeCompare(b.effectId))
        .slice(0, Math.trunc(limit));
      for (const effect of due) tx.putEffect({ ...effect, status: 'leased', leaseId,
        leaseUntilIso: new Date(new Date(nowIso).getTime() + 30_000).toISOString() });
      return due.map(({ effectId, effect, attempts, nextAttemptAtIso }) =>
        ({ effectId, effect, attempts, nextAttemptAtIso }));
    });
  }

  markEffectSent(effectId: string, sentAtIso: string): Promise<void> {
    return this.execute(async (tx) => {
      const effect = await tx.requireEffect(effectId);
      delete effect.leaseId; delete effect.leaseUntilIso;
      tx.putEffect({ ...effect, status: 'sent', sentAtIso });
    });
  }

  rescheduleEffect(effectId: string, attempts: number, nextAttemptAtIso: string, safeError: string): Promise<void> {
    return this.execute((tx) => tx.retryEffect(effectId, attempts, nextAttemptAtIso, safeError));
  }

  rescheduleEffectWithNotice(effectId: string, attempts: number, nextAttemptAtIso: string, safeError: string,
    noticeEffectId: string, notice: AdminErrorEffect, noticeAtIso: string): Promise<void> {
    return this.execute(async (tx) => {
      await tx.retryEffect(effectId, attempts, nextAttemptAtIso, safeError);
      if (!await tx.get('outbox', noticeEffectId)) await tx.enqueue(noticeEffectId, notice, noticeAtIso);
    });
  }

  markEffectPermanentlyFailed(effectId: string, failedAtIso: string, safeError: string): Promise<void> {
    return this.execute(async (tx) => {
      const effect = await tx.requireEffect(effectId);
      delete effect.leaseId; delete effect.leaseUntilIso;
      tx.putEffect({ ...effect, status: 'failed', failedAtIso });
      tx.put('settings', 'last_safe_error', redactTelegramTokens(safeError).slice(0, 500));
    });
  }

  getOperationalStatus(): Promise<OperationalStatus> {
    return this.execute(async (tx) => {
      const pendingEffectCount = (await tx.list('outbox', undefined, ['pending', 'leased'])).length;
      const lastSafeError = await tx.get<string>('settings', 'last_safe_error');
      return lastSafeError === undefined ? { pendingEffectCount } : { pendingEffectCount, lastSafeError };
    });
  }

  private async execute<T>(work: (tx: D1Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const head = await this.db.prepare('SELECT revision FROM bot_revision WHERE id = 1').first<{ revision: number }>();
      if (!head) throw new Error('D1 migration has not been applied');
      const tx = new D1Transaction(this.db);
      const value = await work(tx);
      if (tx.changes.size === 0) {
        const tail = await this.db.prepare('SELECT revision FROM bot_revision WHERE id = 1').first<{ revision: number }>();
        if (tail?.revision === head.revision) return value;
        continue;
      }
      const token = crypto.randomUUID();
      const changes = [...tx.changes.values()];
      const puts = changes.filter((item): item is DatabaseRecord => item.payload !== undefined);
      const deletes = changes.filter((item) => item.payload === undefined);
      const result = await this.db.batch([
        this.db.prepare('UPDATE bot_revision SET revision = revision + 1, commit_id = ? WHERE id = 1 AND revision = ?')
          .bind(token, head.revision),
        this.db.prepare(`DELETE FROM bot_records WHERE EXISTS (SELECT 1 FROM bot_revision WHERE id = 1 AND commit_id = ?)
          AND EXISTS (SELECT 1 FROM json_each(?) AS change WHERE json_extract(change.value, '$.kind') = bot_records.kind
          AND json_extract(change.value, '$.id') = bot_records.id)`).bind(token, JSON.stringify(deletes)),
        this.db.prepare(`INSERT INTO bot_records(kind, id, scope, status, payload)
          SELECT json_extract(value, '$.kind'), json_extract(value, '$.id'), json_extract(value, '$.scope'),
            json_extract(value, '$.status'), json_extract(value, '$.payload') FROM json_each(?)
          WHERE EXISTS (SELECT 1 FROM bot_revision WHERE id = 1 AND commit_id = ?)
          ON CONFLICT(kind, id) DO UPDATE SET scope = excluded.scope, status = excluded.status, payload = excluded.payload`)
          .bind(JSON.stringify(puts), token),
      ]);
      if (result[0]?.meta.changes === 1) return value;
    }
    throw new Error('Concurrent D1 transaction could not be committed; retry the update');
  }
}

type Change = { kind: string; id: string; scope?: string; status?: string; payload?: string };
class D1Transaction implements FootballTransaction {
  readonly changes = new Map<string, Change>();
  private membersSnapshot: DatabaseRecord[] | undefined;
  constructor(private readonly db: FootballDatabase) {}

  async get<T>(kind: string, id: string): Promise<T | undefined> {
    const change = this.changes.get(JSON.stringify([kind, id]));
    if (change) return change.payload === undefined ? undefined : decode<T>(change.payload);
    const row = await this.db.prepare('SELECT payload FROM bot_records WHERE kind = ? AND id = ?')
      .bind(kind, id).first<{ payload: string }>();
    return row ? decode<T>(row.payload) : undefined;
  }

  async list<T>(kind: string, scope?: string, statuses?: string[]): Promise<T[]> {
    let sql = 'SELECT kind, id, scope, status, payload FROM bot_records WHERE kind = ?';
    const params: unknown[] = [kind];
    if (scope !== undefined) { sql += ' AND scope = ?'; params.push(scope); }
    if (statuses) { sql += ` AND status IN (${statuses.map(() => '?').join(',')})`; params.push(...statuses); }
    let results: DatabaseRecord[];
    if (kind === 'team_members') {
      // A season rating reads several sessions. One indexed snapshot, plus staged
      // changes below, keeps that operation within the Workers Free query budget.
      this.membersSnapshot ??= (await this.db.prepare('SELECT kind,id,scope,status,payload FROM bot_records WHERE kind = ?')
        .bind(kind).all<DatabaseRecord>()).results;
      results = this.membersSnapshot.filter((row) => (scope === undefined || row.scope === scope)
        && (!statuses || statuses.includes(row.status)));
    } else {
      results = (await this.db.prepare(sql).bind(...params).all<DatabaseRecord>()).results;
    }
    const rows = new Map(results.map((row) => [JSON.stringify([row.kind, row.id]), row]));
    for (const [key, change] of this.changes) {
      if (change.kind !== kind) continue;
      rows.delete(key);
      if (change.payload !== undefined && (scope === undefined || change.scope === scope)
        && (!statuses || statuses.includes(change.status ?? ''))) rows.set(key, change as DatabaseRecord);
    }
    return [...rows.values()].map((row) => decode<T>(row.payload));
  }

  put(kind: string, id: string, value: unknown, scope = '', status = ''): void {
    this.changes.set(JSON.stringify([kind, id]), { kind, id, scope, status, payload: encodeRecord(value) });
  }
  remove(kind: string, id: string): void { this.changes.set(JSON.stringify([kind, id]), { kind, id }); }
  putEffect(effect: EffectRecord): void {
    this.put('outbox', effect.effectId, effect, 'sessionId' in effect.effect ? effect.effect.sessionId : '', effect.status);
  }
  async requireEffect(effectId: string): Promise<EffectRecord> {
    const effect = await this.get<EffectRecord>('outbox', effectId);
    if (!effect) throw new Error('effect not found');
    return effect;
  }
  async retryEffect(effectId: string, attempts: number, nextAttemptAtIso: string, safeError: string): Promise<void> {
    const effect = await this.requireEffect(effectId);
    delete effect.leaseId; delete effect.leaseUntilIso; delete effect.sentAtIso; delete effect.failedAtIso;
    this.putEffect({ ...effect, status: 'pending', attempts, nextAttemptAtIso });
    this.put('settings', 'last_safe_error', redactTelegramTokens(safeError).slice(0, 500));
  }

  async getSettings(): Promise<BotSettings> { return await this.get<BotSettings>('settings', 'bot') ?? {}; }
  async saveSettings(settings: BotSettings): Promise<void> { this.put('settings', 'bot', settings); }
  async upsertPlayer(player: PlayerProfile, _nowIso: string): Promise<void> { this.put('players', player.telegramUserId, player); }
  async listPlayers(): Promise<PlayerProfile[]> {
    return (await this.list<PlayerProfile>('players')).sort((a, b) => a.telegramUserId.localeCompare(b.telegramUserId));
  }
  getSession(sessionId: string): Promise<Session | undefined> { return this.get('sessions', sessionId); }
  async saveSession(session: Session): Promise<void> { this.put('sessions', session.sessionId, session, '', session.status); }

  async cancelSession(sessionId: string): Promise<void> {
    if (!await this.getSession(sessionId)) throw new Error('session not found');
    for (const kind of ['participants', 'teams', 'team_members', 'win_events', 'win_awards', 'scheduled_actions', 'outbox']) {
      const { results } = await this.db.prepare('SELECT id FROM bot_records WHERE kind = ? AND scope = ?')
        .bind(kind, sessionId).all<{ id: string }>();
      const ids = new Set(results.map((row) => row.id));
      for (const change of this.changes.values()) if (change.kind === kind && change.scope === sessionId) ids.add(change.id);
      for (const id of ids) {
        if (kind === 'outbox' && (await this.get<EffectRecord>(kind, id))?.effect.kind === 'session_cancelled') continue;
        this.remove(kind, id);
      }
    }
    await this.saveSession({ sessionId, status: 'cancelled', nextQueuePosition: 1n, nextWinOrdinal: 1n });
  }

  async listParticipants(sessionId: string): Promise<Participant[]> {
    return (await this.list<Participant>('participants', sessionId)).sort(compareParticipants);
  }
  async replaceParticipants(sessionId: string, participants: readonly Participant[]): Promise<void> {
    for (const p of await this.listParticipants(sessionId)) this.remove('participants', scopedId(sessionId, p.participantId));
    for (const p of participants) this.put('participants', scopedId(sessionId, p.participantId), p, sessionId);
  }
  async removeCompletedParticipant(sessionId: string, participantId: string): Promise<void> {
    if ((await this.getSession(sessionId))?.status !== 'finished') throw new Error('session is not finished');
    const participant = await this.get<Participant>('participants', scopedId(sessionId, participantId));
    if (!participant) throw new Error('participant not found');
    this.remove('participants', scopedId(sessionId, participantId));
    for (const member of await this.listTeamMembers(sessionId)) {
      if (member.participantId === participantId) this.remove('team_members', scopedId(sessionId, member.participantId));
    }
    if (participant.telegramUserId !== undefined) for (const award of await this.listWinAwards(sessionId)) {
      if (award.telegramUserId === participant.telegramUserId) this.remove('win_awards', awardId(award));
    }
  }
  async listTeams(sessionId: string): Promise<Team[]> {
    return (await this.list<Team>('teams', sessionId)).sort((a, b) => a.teamNumber - b.teamNumber);
  }
  async listTeamMembers(sessionId: string): Promise<TeamMember[]> {
    return (await this.list<TeamMember>('team_members', sessionId))
      .sort((a, b) => a.teamNumber - b.teamNumber || compareParticipants(a, b));
  }
  async replaceTeams(sessionId: string, teams: readonly Team[], members: readonly TeamMember[]): Promise<void> {
    for (const team of await this.listTeams(sessionId)) this.remove('teams', scopedId(sessionId, team.teamNumber));
    for (const m of await this.listTeamMembers(sessionId)) this.remove('team_members', scopedId(sessionId, m.participantId));
    for (const team of teams) this.put('teams', scopedId(sessionId, team.teamNumber), team, sessionId);
    for (const m of members.filter((m) => m.rosterStatus === 'active').slice(0, 20)) {
      this.put('team_members', scopedId(sessionId, m.participantId), m, sessionId);
    }
  }
  async listWinEvents(sessionId?: string): Promise<WinEvent[]> {
    return (await this.list<WinEvent>('win_events', sessionId))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || compareBigInt(a.ordinal, b.ordinal));
  }
  async listWinAwards(sessionId?: string): Promise<WinAward[]> {
    return (await this.list<WinAward>('win_awards', sessionId)).sort((a, b) => a.sessionId.localeCompare(b.sessionId)
      || compareBigInt(a.winOrdinal, b.winOrdinal) || a.telegramUserId.localeCompare(b.telegramUserId));
  }
  async appendWin(event: WinEvent, awards: readonly WinAward[]): Promise<void> {
    const id = scopedId(event.sessionId, event.ordinal.toString());
    if (await this.get('win_events', id)) throw new Error('duplicate win event');
    const ids = new Set<string>();
    for (const award of awards) {
      const key = awardId(award);
      if (ids.has(key) || await this.get('win_awards', key)) throw new Error('duplicate win award');
      ids.add(key); this.put('win_awards', key, award, award.sessionId);
    }
    this.put('win_events', id, event, event.sessionId);
  }
  async reverseWin(sessionId: string, ordinal: bigint, reversedAtIso: string): Promise<void> {
    const id = scopedId(sessionId, ordinal.toString());
    const event = await this.get<WinEvent>('win_events', id);
    if (!event) throw new Error('win event not found');
    this.put('win_events', id, { ...event, reversedAtIso }, sessionId);
  }
  async listCompletedSessionIds(): Promise<Set<string>> {
    return new Set((await this.list<Session>('sessions', undefined, ['finished'])).map((session) => session.sessionId));
  }
  async hasScheduledAction(actionKey: string): Promise<boolean> { return !!await this.get('scheduled_actions', actionKey); }
  async markScheduledAction(actionKey: string, sessionId: string, kind: string, executedAtIso: string): Promise<void> {
    if (await this.hasScheduledAction(actionKey)) throw new Error('duplicate scheduled action');
    this.put('scheduled_actions', actionKey, { sessionId, kind, executedAtIso }, sessionId);
  }
  async hasSessionCancellationNotice(sessionId: string): Promise<boolean> {
    return (await this.list<EffectRecord>('outbox', sessionId)).some((record) => record.effect.kind === 'session_cancelled');
  }
  async enqueue(effectId: string, effect: TelegramEffect, nowIso: string): Promise<void> {
    if (await this.get('outbox', effectId)) throw new Error('duplicate effect');
    this.putEffect({ effectId, effect, attempts: 0, nextAttemptAtIso: nowIso, createdAtIso: nowIso, status: 'pending' });
  }
}

export function scopedId(sessionId: string, id: string | number): string { return JSON.stringify([sessionId, id]); }
export function awardId(award: WinAward): string {
  return JSON.stringify([award.sessionId, award.winOrdinal.toString(), award.telegramUserId]);
}
function compareBigInt(a: bigint, b: bigint): number { return a < b ? -1 : a > b ? 1 : 0; }
function compareParticipants(a: Participant, b: Participant): number {
  return compareBigInt(a.queuePosition, b.queuePosition) || a.participantId.localeCompare(b.participantId);
}
