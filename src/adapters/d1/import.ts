import { awardId, encodeRecord, scopedId, type DatabaseRecord } from './store';
import type { Participant, Session, Team, TeamMember, WinAward, WinEvent } from '../../domain/model';

type Row = Record<string, unknown>;
const TABLES = ['settings', 'players', 'sessions', 'participants', 'teams', 'team_members',
  'win_events', 'win_awards', 'processed_updates', 'scheduled_actions', 'outbox'] as const;
const STATUSES = ['scheduled', 'registration_open', 'registration_closed', 'playing', 'finished', 'cancelled'];

export function recordsFromYdbSnapshot(snapshot: { tables: Record<string, Row[]> }): DatabaseRecord[] {
  for (const name of TABLES) if (!Array.isArray(snapshot.tables[name])) throw new Error(`Missing export table: ${name}`);
  const records: DatabaseRecord[] = [];
  const add = (kind: string, id: string, payload: unknown, scope = '', status = '') => {
    records.push({ kind, id, scope, status, payload: encodeRecord(payload) });
  };
  const rows = (name: typeof TABLES[number]): Row[] => snapshot.tables[name]!;
  for (const row of rows('settings')) {
    const key = str(row, 'key');
    if (key === 'group_chat_id') add('settings', 'bot', { groupChatId: str(row, 'value') });
    else add('settings', key, str(row, 'value'));
  }
  for (const row of rows('players')) add('players', str(row, 'telegram_user_id'), {
    telegramUserId: str(row, 'telegram_user_id'), displayName: str(row, 'display_name'), ...optional(row, 'username', 'username'),
  });
  for (const row of rows('sessions')) {
    const status = str(row, 'status');
    if (!STATUSES.includes(status)) throw new Error('Invalid exported session status');
    const session: Session = { sessionId: str(row, 'session_id'), status: status as Session['status'],
      nextQueuePosition: counter(row, 'next_queue_position'), nextWinOrdinal: counter(row, 'next_win_ordinal'),
      ...optional(row, 'registration_message_id', 'registrationMessageId'), ...optional(row, 'score_message_id', 'scoreMessageId') };
    add('sessions', session.sessionId, session, '', status);
  }
  for (const row of rows('participants')) {
    const value = participant(row);
    add('participants', scopedId(value.sessionId, value.participantId), value, value.sessionId);
  }
  for (const row of rows('teams')) {
    const team: Team = { sessionId: str(row, 'session_id'), teamNumber: teamNumber(row) };
    add('teams', scopedId(team.sessionId, team.teamNumber), team, team.sessionId);
  }
  for (const row of rows('team_members')) {
    const role = str(row, 'role');
    if (role !== 'starter' && role !== 'reserve') throw new Error('Invalid exported team role');
    const member: TeamMember = { ...participant(row), teamNumber: teamNumber(row), role };
    add('team_members', scopedId(member.sessionId, member.participantId), member, member.sessionId);
  }
  for (const row of rows('win_events')) {
    const event: WinEvent = { sessionId: str(row, 'session_id'), ordinal: counter(row, 'ordinal'),
      teamNumber: teamNumber(row), adminUserId: str(row, 'admin_user_id'), createdAtIso: date(row, 'created_at'),
      ...optional(row, 'reversed_at', 'reversedAtIso') };
    add('win_events', scopedId(event.sessionId, event.ordinal.toString()), event, event.sessionId);
  }
  for (const row of rows('win_awards')) {
    const award: WinAward = { sessionId: str(row, 'session_id'), winOrdinal: counter(row, 'win_ordinal'),
      telegramUserId: str(row, 'telegram_user_id'), displayName: str(row, 'display_name') };
    add('win_awards', awardId(award), award, award.sessionId);
  }
  for (const row of rows('processed_updates')) add('processed_updates', str(row, 'update_id'), {
    processedAtIso: date(row, 'processed_at'),
  });
  for (const row of rows('scheduled_actions')) add('scheduled_actions', str(row, 'action_key'), {
    sessionId: str(row, 'session_id'), kind: str(row, 'kind'), executedAtIso: date(row, 'executed_at'),
  }, str(row, 'session_id'));
  for (const row of rows('outbox')) {
    const effect = JSON.parse(str(row, 'payload_json')) as Record<string, unknown>;
    if (effect.kind !== str(row, 'kind')) throw new Error('Invalid exported outbox effect');
    const status = str(row, 'status');
    if (!['pending', 'leased', 'sent', 'failed'].includes(status)) throw new Error('Invalid exported outbox status');
    add('outbox', str(row, 'effect_id'), { effectId: str(row, 'effect_id'), effect, status,
      attempts: integer(row, 'attempts'), nextAttemptAtIso: date(row, 'next_attempt_at'), createdAtIso: date(row, 'created_at'),
      ...optional(row, 'lease_id', 'leaseId'), ...optional(row, 'lease_until', 'leaseUntilIso'),
      ...optional(row, 'sent_at', 'sentAtIso'), ...optional(row, 'failed_at', 'failedAtIso') },
      typeof effect.sessionId === 'string' ? effect.sessionId : '', status);
  }
  const keys = new Set(records.map((record) => JSON.stringify([record.kind, record.id])));
  if (keys.size !== records.length) throw new Error('Duplicate exported record identity');
  return records;
}

function str(row: Row, key: string): string {
  if (typeof row[key] !== 'string') throw new Error(`Invalid exported field: ${key}`);
  return row[key];
}
function optional(row: Row, key: string, name: string): Record<string, string> {
  return row[key] === null || row[key] === undefined ? {} : { [name]: str(row, key) };
}
function counter(row: Row, key: string): bigint {
  const value = row[key];
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`Invalid exported counter: ${key}`);
  return BigInt(value);
}
function integer(row: Row, key: string): number {
  if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error(`Invalid exported integer: ${key}`);
  return row[key];
}
function date(row: Row, key: string): string {
  const iso = str(row, key);
  if (!Number.isFinite(new Date(iso).getTime())) throw new Error(`Invalid exported timestamp: ${key}`);
  return new Date(iso).toISOString();
}
function teamNumber(row: Row): Team['teamNumber'] {
  const value = integer(row, 'team_number');
  if (value < 1 || value > 4) throw new Error('Invalid exported team number');
  return value as Team['teamNumber'];
}
function participant(row: Row): Participant {
  const kind = str(row, 'kind');
  const rosterStatus = str(row, 'roster_status');
  if (kind !== 'player' && kind !== 'guest') throw new Error('Invalid exported participant kind');
  if (rosterStatus !== 'active' && rosterStatus !== 'waitlist') throw new Error('Invalid exported roster status');
  const guest = row.guest_number;
  if (guest !== null && guest !== undefined && guest !== 1 && guest !== 2) throw new Error('Invalid exported guest number');
  return { participantId: str(row, 'participant_id'), sessionId: str(row, 'session_id'),
    ownerUserId: str(row, 'owner_user_id'), ...optional(row, 'telegram_user_id', 'telegramUserId'),
    displayName: str(row, 'display_name'), kind, rosterStatus, queuePosition: counter(row, 'queue_position'),
    ...(guest === 1 || guest === 2 ? { guestNumber: guest } : {}) };
}
