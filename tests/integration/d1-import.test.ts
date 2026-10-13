import { expect, it } from 'vitest';
import { recordsFromYdbSnapshot } from '../../src/adapters/d1/import';

it('keeps identifiers and 64-bit counters exact, and does not replay sent Telegram messages', () => {
  const snapshot = { tables: {
    settings: [{ key: 'group_chat_id', value: '-1001' }], players: [],
    sessions: [{ session_id: '2026-10-09', status: 'finished', next_queue_position: '9007199254740993',
      next_win_ordinal: '2', registration_message_id: '41', score_message_id: null }],
    participants: [], teams: [], team_members: [], win_events: [], win_awards: [], processed_updates: [], scheduled_actions: [],
    outbox: [{ effect_id: 'sent', kind: 'registration_card', payload_json: '{"kind":"registration_card","sessionId":"2026-10-09"}',
      status: 'sent', attempts: 0, next_attempt_at: '2026-10-09T10:00:00.000Z', created_at: '2026-10-09T10:00:00.000Z',
      sent_at: '2026-10-09T10:00:01.000Z', failed_at: null, lease_id: null, lease_until: null }],
  } };
  const records = recordsFromYdbSnapshot(snapshot);
  expect(records.find((record) => record.kind === 'sessions')?.payload).toContain('9007199254740993');
  expect(records.find((record) => record.kind === 'settings')?.payload).toBe('{"groupChatId":"-1001"}');
  expect(records.find((record) => record.kind === 'outbox')?.status).toBe('sent');
});

it('fails rather than treating a missing export table as empty history', () => {
  expect(() => recordsFromYdbSnapshot({ tables: {} })).toThrow('Missing export table');
});
