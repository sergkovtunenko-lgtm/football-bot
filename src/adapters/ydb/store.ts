import type { Driver } from '@ydbjs/core';
import { fragment, join, query, type Fragment, type QueryClient, type TX } from '@ydbjs/query';
import { Timestamp, Uint8, Uint32, Uint64 } from '@ydbjs/value/primitive';
import type {
  Participant,
  PlayerProfile,
  Session,
  Team,
  TeamMember,
  WinAward,
  WinEvent,
} from '../../domain/model';
import type {
  BotSettings,
  FootballStore,
  FootballTransaction,
  OperationalStatus,
  StoredEffect,
  TelegramEffect,
  UpdateExecution,
} from '../../ports/store';

const TRANSACTION_OPTIONS = { isolation: 'serializableReadWrite', idempotent: true } as const;
const LEASE_MILLISECONDS = 30_000;
const SAFE_ERROR_LIMIT = 500;
const TELEGRAM_TOKEN = /\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b/g;

export class YdbFootballStore implements FootballStore {
  private readonly sql: QueryClient;

  constructor(driver: Driver) {
    this.sql = query(driver);
  }

  transact<T>(work: (tx: FootballTransaction) => Promise<T>): Promise<T> {
    return this.sql.begin(TRANSACTION_OPTIONS, (tx) => work(new YdbFootballTransaction(tx)));
  }

  transactUpdate<T>(
    updateId: string,
    nowIso: string,
    work: (tx: FootballTransaction) => Promise<T>,
  ): Promise<UpdateExecution<T>> {
    return this.sql.begin(TRANSACTION_OPTIONS, async (tx) => {
      const [rows] = await tx<[{ update_id: string }]>`
        SELECT update_id FROM processed_updates WHERE update_id = ${updateId}
      `;
      if (rows.length > 0) return { duplicate: true };

      await tx`
        INSERT INTO processed_updates (update_id, processed_at)
        VALUES (${updateId}, ${timestamp(nowIso)})
      `;
      const value = await work(new YdbFootballTransaction(tx));
      return { duplicate: false, value };
    });
  }

  claimDueEffects(nowIso: string, limit: number, leaseId: string): Promise<StoredEffect[]> {
    const safeLimit = Math.max(0, Math.trunc(limit));
    if (safeLimit === 0) return Promise.resolve([]);
    const now = isoDate(nowIso);
    const leaseUntil = new Date(now.getTime() + LEASE_MILLISECONDS);

    return this.sql.begin(TRANSACTION_OPTIONS, async (tx) => {
      const [rows] = await tx<[OutboxRow]>`
        SELECT effect_id, kind, payload_json, attempts, next_attempt_at
        FROM outbox
        WHERE next_attempt_at <= ${new Timestamp(now)}
          AND (
            status = ${'pending'}
            OR (status = ${'leased'} AND (lease_until IS NULL OR lease_until <= ${new Timestamp(now)}))
          )
        ORDER BY next_attempt_at, created_at, effect_id
        LIMIT ${new Uint64(BigInt(safeLimit))}
      `;
      for (const row of rows) {
        await tx`
          UPDATE outbox
          SET status = ${'leased'}, lease_id = ${leaseId}, lease_until = ${new Timestamp(leaseUntil)}
          WHERE effect_id = ${row.effect_id}
        `;
      }
      return rows.map(storedEffect);
    });
  }

  markEffectSent(effectId: string, sentAtIso: string): Promise<void> {
    return this.sql.begin(TRANSACTION_OPTIONS, async (tx) => {
      await requireEffect(tx, effectId);
      await tx`
        UPDATE outbox
        SET status = ${'sent'}, sent_at = ${timestamp(sentAtIso)}, lease_id = NULL, lease_until = NULL
        WHERE effect_id = ${effectId}
      `;
    });
  }

  rescheduleEffect(
    effectId: string,
    attempts: number,
    nextAttemptAtIso: string,
    safeError: string,
  ): Promise<void> {
    return this.sql.begin(TRANSACTION_OPTIONS, async (tx) => {
      await requireEffect(tx, effectId);
      await tx`
        UPDATE outbox
        SET status = ${'pending'}, attempts = ${uint32(attempts)},
            next_attempt_at = ${timestamp(nextAttemptAtIso)}, lease_id = NULL, lease_until = NULL,
            sent_at = NULL, failed_at = NULL, last_error = ${storedSafeError(safeError)}
        WHERE effect_id = ${effectId}
      `;
      await saveLastSafeError(tx, safeError);
    });
  }

  markEffectPermanentlyFailed(effectId: string, failedAtIso: string, safeError: string): Promise<void> {
    return this.sql.begin(TRANSACTION_OPTIONS, async (tx) => {
      await requireEffect(tx, effectId);
      await tx`
        UPDATE outbox
        SET status = ${'failed'}, failed_at = ${timestamp(failedAtIso)},
            lease_id = NULL, lease_until = NULL, last_error = ${storedSafeError(safeError)}
        WHERE effect_id = ${effectId}
      `;
      await saveLastSafeError(tx, safeError);
    });
  }

  getOperationalStatus(): Promise<OperationalStatus> {
    return this.sql.begin(TRANSACTION_OPTIONS, async (tx) => {
      const [countRows] = await tx<[{ pending_count: bigint }]>`
        SELECT COUNT(*) AS pending_count FROM outbox WHERE status IN (${'pending'}, ${'leased'})
      `;
      const [errorRows] = await tx<[{ value: string }]>`
        SELECT value FROM settings WHERE key = ${'last_safe_error'}
      `;
      const pendingEffectCount = Number(countRows[0]?.pending_count ?? 0n);
      const lastSafeError = errorRows[0]?.value;
      return lastSafeError === undefined ? { pendingEffectCount } : { pendingEffectCount, lastSafeError };
    });
  }
}

class YdbFootballTransaction implements FootballTransaction {
  constructor(private readonly tx: TX) {}

  async getSettings(): Promise<BotSettings> {
    const [rows] = await this.tx<[{ value: string }]>`
      SELECT value FROM settings WHERE key = ${'group_chat_id'}
    `;
    const groupChatId = rows[0]?.value;
    return groupChatId === undefined ? {} : { groupChatId };
  }

  async saveSettings(settings: BotSettings): Promise<void> {
    await this.tx`DELETE FROM settings WHERE key = ${'group_chat_id'}`;
    if (settings.groupChatId !== undefined) {
      await this.tx`
        INSERT INTO settings (key, value, updated_at)
        VALUES (${'group_chat_id'}, ${settings.groupChatId}, CurrentUtcTimestamp())
      `;
    }
  }

  async upsertPlayer(player: PlayerProfile, nowIso: string): Promise<void> {
    await this.tx`
      UPSERT INTO players (telegram_user_id, display_name, username, updated_at)
      VALUES (
        ${player.telegramUserId}, ${player.displayName}, ${nullable(player.username)}, ${timestamp(nowIso)}
      )
    `;
  }

  async listPlayers(): Promise<PlayerProfile[]> {
    const [rows] = await this.tx<[PlayerRow]>`
      SELECT telegram_user_id, display_name, username FROM players ORDER BY telegram_user_id
    `;
    return rows.map((row) => row.username === null
      ? { telegramUserId: row.telegram_user_id, displayName: row.display_name }
      : { telegramUserId: row.telegram_user_id, displayName: row.display_name, username: row.username });
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    const [rows] = await this.tx<[SessionRow]>`
      SELECT session_id, status, next_queue_position, next_win_ordinal,
             registration_message_id, score_message_id
      FROM sessions WHERE session_id = ${sessionId}
    `;
    const row = rows[0];
    if (!row) return undefined;
    return sessionFromRow(row);
  }

  async saveSession(session: Session): Promise<void> {
    const [rows] = await this.tx<[{ session_id: string }]>`
      SELECT session_id FROM sessions WHERE session_id = ${session.sessionId}
    `;
    const closes = ['registration_closed', 'playing', 'finished'].includes(session.status);
    const finishes = session.status === 'finished';
    if (rows.length === 0) {
      await this.tx`
        INSERT INTO sessions (
          session_id, status, next_queue_position, next_win_ordinal,
          registration_message_id, score_message_id, created_at, closed_at, finished_at
        ) VALUES (
          ${session.sessionId}, ${session.status}, ${new Uint64(session.nextQueuePosition)},
          ${new Uint64(session.nextWinOrdinal)}, ${nullable(session.registrationMessageId)},
          ${nullable(session.scoreMessageId)}, CurrentUtcTimestamp(),
          ${closes ? fragment`CurrentUtcTimestamp()` : fragment`NULL`},
          ${finishes ? fragment`CurrentUtcTimestamp()` : fragment`NULL`}
        )
      `;
      return;
    }

    await this.tx`
      UPDATE sessions
      SET status = ${session.status}, next_queue_position = ${new Uint64(session.nextQueuePosition)},
          next_win_ordinal = ${new Uint64(session.nextWinOrdinal)},
          registration_message_id = ${nullable(session.registrationMessageId)},
          score_message_id = ${nullable(session.scoreMessageId)},
          closed_at = CASE
            WHEN closed_at IS NULL AND ${closes} THEN CurrentUtcTimestamp()
            ELSE closed_at
          END,
          finished_at = CASE
            WHEN finished_at IS NULL AND ${finishes} THEN CurrentUtcTimestamp()
            ELSE finished_at
          END
      WHERE session_id = ${session.sessionId}
    `;
  }

  async listParticipants(sessionId: string): Promise<Participant[]> {
    const [rows] = await this.tx<[ParticipantRow]>`
      SELECT session_id, participant_id, owner_user_id, telegram_user_id, display_name,
             kind, guest_number, queue_position, roster_status
      FROM participants
      WHERE session_id = ${sessionId}
      ORDER BY queue_position, participant_id
    `;
    return rows.map(participantFromRow);
  }

  async replaceParticipants(sessionId: string, participants: readonly Participant[]): Promise<void> {
    await this.tx`DELETE FROM participants WHERE session_id = ${sessionId}`;
    if (participants.length === 0) return;
    const rows = participants.map((participant) => fragment`(
      ${sessionId}, ${participant.participantId}, ${participant.ownerUserId},
      ${nullable(participant.telegramUserId)}, ${participant.displayName}, ${participant.kind},
      ${nullableUint8(participant.guestNumber)}, ${new Uint64(participant.queuePosition)},
      ${participant.rosterStatus}
    )`);
    await this.tx`
      INSERT INTO participants (
        session_id, participant_id, owner_user_id, telegram_user_id, display_name,
        kind, guest_number, queue_position, roster_status
      ) VALUES ${join(rows, ', ')}
    `;
  }

  async listTeams(sessionId: string): Promise<Team[]> {
    const [rows] = await this.tx<[{ session_id: string; team_number: number }]>`
      SELECT session_id, team_number FROM teams
      WHERE session_id = ${sessionId} ORDER BY team_number
    `;
    return rows.map((row) => ({ sessionId: row.session_id, teamNumber: teamNumber(row.team_number) }));
  }

  async listTeamMembers(sessionId: string): Promise<TeamMember[]> {
    const [rows] = await this.tx<[TeamMemberRow]>`
      SELECT session_id, participant_id, owner_user_id, telegram_user_id,
             display_name, kind, guest_number, queue_position, roster_status,
             team_number, role
      FROM team_members
      WHERE session_id = ${sessionId}
      ORDER BY team_number, queue_position, participant_id
    `;
    return rows.map((row) => ({
      ...participantFromRow(row),
      teamNumber: teamNumber(row.team_number),
      role: teamRole(row.role),
    }));
  }

  async replaceTeams(sessionId: string, teams: readonly Team[], members: readonly TeamMember[]): Promise<void> {
    await this.tx`DELETE FROM team_members WHERE session_id = ${sessionId}`;
    await this.tx`DELETE FROM teams WHERE session_id = ${sessionId}`;
    if (teams.length > 0) {
      const teamRows = teams.map((team) => fragment`(
        ${sessionId}, ${new Uint8(team.teamNumber)}
      )`);
      await this.tx`
        INSERT INTO teams (session_id, team_number) VALUES ${join(teamRows, ', ')}
      `;
    }
    const activeMembers = members.filter((member) => member.rosterStatus === 'active').slice(0, 20);
    if (activeMembers.length > 0) {
      const memberRows = activeMembers.map((member) => fragment`(
        ${sessionId}, ${new Uint8(member.teamNumber)}, ${member.participantId}, ${member.ownerUserId},
        ${nullable(member.telegramUserId)}, ${member.displayName}, ${member.kind},
        ${nullableUint8(member.guestNumber)}, ${new Uint64(member.queuePosition)},
        ${member.rosterStatus}, ${member.role}
      )`);
      await this.tx`
        INSERT INTO team_members (
          session_id, team_number, participant_id, owner_user_id, telegram_user_id,
          display_name, kind, guest_number, queue_position, roster_status, role
        )
        VALUES ${join(memberRows, ', ')}
      `;
    }
  }

  async listWinEvents(sessionId?: string): Promise<WinEvent[]> {
    const filter = sessionId === undefined
      ? fragment``
      : fragment`WHERE session_id = ${sessionId}`;
    const [rows] = await this.tx<[WinEventRow]>`
      SELECT session_id, ordinal, team_number, admin_user_id, created_at, reversed_at
      FROM win_events ${filter} ORDER BY session_id, ordinal
    `;
    return rows.map((row) => row.reversed_at === null ? {
      sessionId: row.session_id,
      ordinal: row.ordinal,
      teamNumber: teamNumber(row.team_number),
      adminUserId: row.admin_user_id,
      createdAtIso: row.created_at.toISOString(),
    } : {
      sessionId: row.session_id,
      ordinal: row.ordinal,
      teamNumber: teamNumber(row.team_number),
      adminUserId: row.admin_user_id,
      createdAtIso: row.created_at.toISOString(),
      reversedAtIso: row.reversed_at.toISOString(),
    });
  }

  async listWinAwards(sessionId?: string): Promise<WinAward[]> {
    const filter = sessionId === undefined
      ? fragment``
      : fragment`WHERE session_id = ${sessionId}`;
    const [rows] = await this.tx<[WinAwardRow]>`
      SELECT session_id, win_ordinal, telegram_user_id, display_name
      FROM win_awards ${filter} ORDER BY session_id, win_ordinal, telegram_user_id
    `;
    return rows.map((row) => ({
      sessionId: row.session_id,
      winOrdinal: row.win_ordinal,
      telegramUserId: row.telegram_user_id,
      displayName: row.display_name,
    }));
  }

  async appendWin(event: WinEvent, awards: readonly WinAward[]): Promise<void> {
    await this.tx`
      INSERT INTO win_events (session_id, ordinal, team_number, admin_user_id, created_at, reversed_at)
      VALUES (
        ${event.sessionId}, ${new Uint64(event.ordinal)}, ${new Uint8(event.teamNumber)},
        ${event.adminUserId}, ${timestamp(event.createdAtIso)},
        ${event.reversedAtIso === undefined ? fragment`NULL` : fragment`${timestamp(event.reversedAtIso)}`}
      )
    `;
    if (awards.length === 0) return;
    const rows = awards.map((award) => fragment`(
      ${award.sessionId}, ${new Uint64(award.winOrdinal)}, ${award.telegramUserId}, ${award.displayName}
    )`);
    await this.tx`
      INSERT INTO win_awards (session_id, win_ordinal, telegram_user_id, display_name)
      VALUES ${join(rows, ', ')}
    `;
  }

  async reverseWin(sessionId: string, ordinal: bigint, reversedAtIso: string): Promise<void> {
    const [rows] = await this.tx<[{ ordinal: bigint }]>`
      SELECT ordinal FROM win_events
      WHERE session_id = ${sessionId} AND ordinal = ${new Uint64(ordinal)}
    `;
    if (rows.length === 0) throw new Error('win event not found');
    await this.tx`
      UPDATE win_events SET reversed_at = ${timestamp(reversedAtIso)}
      WHERE session_id = ${sessionId} AND ordinal = ${new Uint64(ordinal)}
    `;
  }

  async listCompletedSessionIds(): Promise<Set<string>> {
    const [rows] = await this.tx<[{ session_id: string }]>`
      SELECT session_id FROM sessions WHERE status = ${'finished'} ORDER BY session_id
    `;
    return new Set(rows.map((row) => row.session_id));
  }

  async hasScheduledAction(actionKey: string): Promise<boolean> {
    const [rows] = await this.tx<[{ action_key: string }]>`
      SELECT action_key FROM scheduled_actions WHERE action_key = ${actionKey}
    `;
    return rows.length > 0;
  }

  async markScheduledAction(
    actionKey: string,
    sessionId: string,
    kind: string,
    executedAtIso: string,
  ): Promise<void> {
    await this.tx`
      INSERT INTO scheduled_actions (action_key, session_id, kind, executed_at)
      VALUES (${actionKey}, ${sessionId}, ${kind}, ${timestamp(executedAtIso)})
    `;
  }

  async enqueue(effectId: string, effect: TelegramEffect, nowIso: string): Promise<void> {
    const now = timestamp(nowIso);
    await this.tx`
      INSERT INTO outbox (
        effect_id, kind, payload_json, status, attempts, next_attempt_at,
        lease_id, lease_until, created_at, sent_at, failed_at, last_error
      ) VALUES (
        ${effectId}, ${effect.kind}, ${JSON.stringify(effect)}, ${'pending'}, ${new Uint32(0)}, ${now},
        NULL, NULL, ${now}, NULL, NULL, NULL
      )
    `;
  }
}

interface PlayerRow {
  telegram_user_id: string;
  display_name: string;
  username: string | null;
}

interface SessionRow {
  session_id: string;
  status: string;
  next_queue_position: bigint;
  next_win_ordinal: bigint;
  registration_message_id: string | null;
  score_message_id: string | null;
}

interface ParticipantRow {
  session_id: string;
  participant_id: string;
  owner_user_id: string;
  telegram_user_id: string | null;
  display_name: string;
  kind: string;
  guest_number: number | null;
  queue_position: bigint;
  roster_status: string;
}

interface TeamMemberRow extends ParticipantRow {
  team_number: number;
  role: string;
}

interface WinEventRow {
  session_id: string;
  ordinal: bigint;
  team_number: number;
  admin_user_id: string;
  created_at: Date;
  reversed_at: Date | null;
}

interface WinAwardRow {
  session_id: string;
  win_ordinal: bigint;
  telegram_user_id: string;
  display_name: string;
}

interface OutboxRow {
  effect_id: string;
  kind: string;
  payload_json: string;
  attempts: number;
  next_attempt_at: Date;
}

async function requireEffect(tx: TX, effectId: string): Promise<void> {
  const [rows] = await tx<[{ effect_id: string }]>`
    SELECT effect_id FROM outbox WHERE effect_id = ${effectId}
  `;
  if (rows.length === 0) throw new Error(`effect not found: ${effectId}`);
}

async function saveLastSafeError(tx: TX, safeError: string): Promise<void> {
  await tx`
    UPSERT INTO settings (key, value, updated_at)
    VALUES (${'last_safe_error'}, ${storedSafeError(safeError)}, CurrentUtcTimestamp())
  `;
}

function nullable(value: string | undefined): Fragment {
  return value === undefined ? fragment`NULL` : fragment`${value}`;
}

function nullableUint8(value: number | undefined): Fragment {
  return value === undefined ? fragment`NULL` : fragment`${new Uint8(value)}`;
}

function timestamp(iso: string): Timestamp {
  return new Timestamp(isoDate(iso));
}

function isoDate(iso: string): Date {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) throw new Error(`invalid ISO timestamp: ${iso}`);
  return value;
}

function uint32(value: number): Uint32 {
  if (!Number.isSafeInteger(value) || value < 0 || value > 4_294_967_295) {
    throw new Error(`invalid Uint32 value: ${value}`);
  }
  return new Uint32(value);
}

function storedSafeError(error: string): string {
  return error.replace(TELEGRAM_TOKEN, '[redacted]').slice(0, SAFE_ERROR_LIMIT);
}

function sessionFromRow(row: SessionRow): Session {
  const base: Session = {
    sessionId: row.session_id,
    status: sessionStatus(row.status),
    nextQueuePosition: row.next_queue_position,
    nextWinOrdinal: row.next_win_ordinal,
  };
  return {
    ...base,
    ...(row.registration_message_id === null ? {} : { registrationMessageId: row.registration_message_id }),
    ...(row.score_message_id === null ? {} : { scoreMessageId: row.score_message_id }),
  };
}

function participantFromRow(row: ParticipantRow): Participant {
  return {
    participantId: row.participant_id,
    sessionId: row.session_id,
    ownerUserId: row.owner_user_id,
    ...(row.telegram_user_id === null ? {} : { telegramUserId: row.telegram_user_id }),
    displayName: row.display_name,
    kind: participantKind(row.kind),
    ...(row.guest_number === null ? {} : { guestNumber: guestNumber(row.guest_number) }),
    queuePosition: row.queue_position,
    rosterStatus: rosterStatus(row.roster_status),
  };
}

function storedEffect(row: OutboxRow): StoredEffect {
  const effect = parseEffect(row.payload_json);
  if (effect.kind !== row.kind) throw new Error(`outbox effect kind mismatch: ${row.effect_id}`);
  return {
    effectId: row.effect_id,
    effect,
    attempts: row.attempts,
    nextAttemptAtIso: row.next_attempt_at.toISOString(),
  };
}

function parseEffect(json: string): TelegramEffect {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('invalid outbox effect payload');
  switch (value.kind) {
    case 'registration_card':
    case 'teams':
    case 'score_panel':
    case 'final_results':
      if (typeof value.sessionId === 'string') return { kind: value.kind, sessionId: value.sessionId };
      break;
    case 'promotion_notice':
      if (typeof value.sessionId === 'string' && typeof value.ownerUserId === 'string') {
        return { kind: value.kind, sessionId: value.sessionId, ownerUserId: value.ownerUserId };
      }
      break;
    case 'reminder':
      if (typeof value.sessionId === 'string' && typeof value.actionKey === 'string') {
        return { kind: value.kind, sessionId: value.sessionId, actionKey: value.actionKey };
      }
      break;
    case 'admin_error':
      if (typeof value.correlationId === 'string' && typeof value.summary === 'string') {
        return { kind: value.kind, correlationId: value.correlationId, summary: value.summary };
      }
      break;
  }
  throw new Error('invalid outbox effect payload');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionStatus(value: string): Session['status'] {
  if (value === 'scheduled' || value === 'registration_open' || value === 'registration_closed'
    || value === 'playing' || value === 'finished') return value;
  throw new Error(`invalid session status: ${value}`);
}

function participantKind(value: string): Participant['kind'] {
  if (value === 'player' || value === 'guest') return value;
  throw new Error(`invalid participant kind: ${value}`);
}

function rosterStatus(value: string): Participant['rosterStatus'] {
  if (value === 'active' || value === 'waitlist') return value;
  throw new Error(`invalid roster status: ${value}`);
}

function teamRole(value: string): TeamMember['role'] {
  if (value === 'starter' || value === 'reserve') return value;
  throw new Error(`invalid team role: ${value}`);
}

function teamNumber(value: number): Team['teamNumber'] {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  throw new Error(`invalid team number: ${value}`);
}

function guestNumber(value: number): 1 | 2 {
  if (value === 1 || value === 2) return value;
  throw new Error(`invalid guest number: ${value}`);
}
