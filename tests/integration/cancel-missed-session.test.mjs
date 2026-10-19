import { afterEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { cancellationStatements } from '../../scripts/cancel-missed-20261016.mjs';
import * as cancellation from '../../scripts/cancel-missed-20261016.mjs';

let mf;
afterEach(async () => { await mf?.dispose(); });

async function fixture() {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'], compatibilityDate: '2026-07-27' });
  const db = await mf.getD1Database('DB');
  const schema = readFileSync('migrations/d1/0001.sql', 'utf8');
  await db.batch(schema.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
  const records = [
    ['sessions', '2026-10-16', '', 'playing', JSON.stringify({ sessionId: '2026-10-16', status: 'playing' })],
    ['participants', 'missed-player', '2026-10-16', '', '{}'],
    ['teams', 'missed-team', '2026-10-16', '', '{}'],
    ['team_members', 'missed-member', '2026-10-16', '', '{}'],
    ['win_events', 'missed-win', '2026-10-16', '', '{}'],
    ['win_awards', 'missed-award', '2026-10-16', '', '{}'],
    ['outbox', 'missed-effect', '2026-10-16', 'sent', '{}'],
    ['scheduled_actions', 'missed-close', '2026-10-16', '', '{}'],
    ['sessions', '2026-10-09', '', 'finished', '{"status":"finished"}'],
    ['participants', 'other-player', '2026-10-09', '', '{}'],
    ['win_awards', 'other-award', '2026-10-09', '', '{}'],
    ['players', 'player-global', '', '', '{"displayName":"Global player"}'],
    ['settings', 'bot', '', '', '{}'],
    ['processed_updates', 'update', '', '', '{}'],
  ];
  await db.batch(records.map((row) => db.prepare('INSERT INTO bot_records VALUES (?,?,?,?,?)').bind(...row)));
  return db;
}

const snapshot = async (db) => (await db.prepare('SELECT * FROM bot_records ORDER BY kind,id').all()).results;
const outside = (records) => records.filter((record) => record.scope !== '2026-10-16'
  && !(record.kind === 'sessions' && record.id === '2026-10-16'));

it.each(['', '├ Checking if file needs uploading\n├ Uploading file\n'])('accepts successful Wrangler JSON after import progress (%j)', (prefix) => {
  const output = `${prefix}[{"success":true,"results":[]}]\n`;
  expect(() => cancellation.parseWranglerResponse(output)).not.toThrow();
  expect(cancellation.parseWranglerResponse(output)).toEqual([{ success: true, results: [] }]);
});

it('cancels only October 16 while preserving every unrelated record and profile', async () => {
  const db = await fixture();
  const before = await snapshot(db);
  await db.batch(cancellationStatements(0, 'test-cutover').map((sql) => db.prepare(sql)));
  const after = await snapshot(db);
  expect(outside(after)).toEqual(outside(before));
  expect(after.filter((record) => record.scope === '2026-10-16')).toEqual([]);
  const session = after.find((record) => record.kind === 'sessions' && record.id === '2026-10-16');
  expect(session.status).toBe('cancelled');
  expect(JSON.parse(session.payload).status).toBe('cancelled');
}, 20_000);

it('refuses the complete correction if the backup revision became stale', async () => {
  const db = await fixture();
  const before = await snapshot(db);
  await db.prepare('UPDATE bot_revision SET revision=1 WHERE id=1').run();
  await db.batch(cancellationStatements(0, 'test-cutover').map((sql) => db.prepare(sql)));
  expect(await snapshot(db)).toEqual(before);
}, 20_000);

it('rolls the entire correction back when a statement fails', async () => {
  const db = await fixture();
  const before = await snapshot(db);
  const statements = cancellationStatements(0, 'test-cutover').map((sql) => db.prepare(sql));
  statements.push(db.prepare('INSERT INTO table_that_does_not_exist VALUES (1)'));
  await expect(db.batch(statements)).rejects.toThrow();
  expect(await snapshot(db)).toEqual(before);
  expect((await db.prepare('SELECT revision FROM bot_revision WHERE id=1').first()).revision).toBe(0);
}, 20_000);
