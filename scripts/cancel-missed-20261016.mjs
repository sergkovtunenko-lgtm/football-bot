import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Deliberately scoped to the single missed session approved on 2026-10-19.
const SESSION = '2026-10-16';
export function cancellationStatements(revision, token) {
  if (!Number.isSafeInteger(revision) || revision < 0 || !/^[\w-]+$/.test(token)) throw new Error('Invalid revision guard');
  const guard = `EXISTS (SELECT 1 FROM bot_revision WHERE id=1 AND commit_id='${token}')`;
  const payload = JSON.stringify({ sessionId: SESSION, status: 'cancelled',
    nextQueuePosition: { $bigint: '1' }, nextWinOrdinal: { $bigint: '1' } });
  return [
    `UPDATE bot_revision SET revision=revision+1, commit_id='${token}' WHERE id=1 AND revision=${revision}
      AND EXISTS (SELECT 1 FROM bot_records WHERE kind='sessions' AND id='${SESSION}' AND status<>'cancelled')`,
    `DELETE FROM bot_records WHERE scope='${SESSION}' AND kind IN
      ('participants','teams','team_members','win_events','win_awards','scheduled_actions','outbox') AND ${guard}`,
    `UPDATE bot_records SET status='cancelled', payload='${payload}' WHERE kind='sessions' AND id='${SESSION}' AND ${guard}`,
  ];
}

export function parseWranglerResponse(stdout) {
  // Remote --file imports print progress before their JSON, even with --json.
  const start = stdout.search(/^[\t ]*\[/m);
  if (start < 0) throw new Error('D1 response did not contain JSON');
  const response = JSON.parse(stdout.slice(start));
  if (!Array.isArray(response) || !response.length || response.some((entry) => entry.success !== true)) {
    throw new Error('D1 did not confirm success');
  }
  return response;
}

function remote(args) {
  const result = spawnSync(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute',
    'friday-football-bot-v2', '--config', 'wrangler.bot.jsonc', '--remote', '--json', ...args],
  { encoding: 'utf8', timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Remote D1 operation failed; private output withheld');
  return parseWranglerResponse(result.stdout);
}

function snapshot() {
  const sql = `SELECT revision,commit_id,(SELECT json_group_array(json_object('kind',kind,'id',id,
    'scope',scope,'status',status,'payload',payload)) FROM bot_records) AS records_json FROM bot_revision WHERE id=1`;
  const row = remote(['--command', sql])[0].results[0];
  if (!row || !Number.isSafeInteger(row.revision)) throw new Error('Missing database revision');
  return { revision: row.revision, commitId: row.commit_id, records: JSON.parse(row.records_json) };
}

const canonical = (records) => JSON.stringify([...records].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)));
const related = (row) => row.scope === SESSION || (row.kind === 'sessions' && row.id === SESSION);

function main() {
  const before = snapshot();
  const session = before.records.find((row) => row.kind === 'sessions' && row.id === SESSION);
  if (!session) throw new Error('The approved session does not exist');
  if (session.status === 'cancelled') { console.log(JSON.stringify({ sessionId: SESSION, alreadyCancelled: true })); return; }
  const dir = resolve('.artifacts/cancel-20261016');
  mkdirSync(dir, { recursive: true });
  const backup = resolve(dir, `before-${Date.now()}.json`);
  writeFileSync(backup, JSON.stringify(before), { flag: 'wx' });
  const summary = { sessionId: SESSION, backup, totalRecords: before.records.length,
    sessionRecords: before.records.filter(related).length,
    sha256: createHash('sha256').update(canonical(before.records)).digest('hex') };
  if (!process.argv.includes('--apply')) { console.log(JSON.stringify({ ...summary, applied: false })); return; }
  const token = randomUUID();
  const sqlPath = resolve(dir, `cancel-${token}.sql`);
  writeFileSync(sqlPath, `${cancellationStatements(before.revision, token).join(';\n')};\n`, { flag: 'wx' });
  // Wrangler's remote file import is atomic; never submit these writes as separate CLI calls.
  remote(['--file', sqlPath, '--yes']);
  const after = snapshot();
  if (after.commitId !== token || after.revision !== before.revision + 1) throw new Error('Revision guard did not commit; inspect backup before retrying');
  if (canonical(before.records.filter((row) => !related(row))) !== canonical(after.records.filter((row) => !related(row)))) {
    throw new Error('Unrelated records differ after correction; inspect the private backup');
  }
  const remaining = after.records.filter(related);
  if (remaining.length !== 1 || remaining[0].kind !== 'sessions' || remaining[0].status !== 'cancelled') {
    throw new Error('Session correction did not match the expected cancelled tombstone');
  }
  writeFileSync(resolve(dir, `verified-${token}.json`), JSON.stringify({ ...summary, applied: true,
    unrelatedRecordsUnchanged: true, remainingSessionRecords: 1 }), { flag: 'wx' });
  console.log(JSON.stringify({ ...summary, applied: true, unrelatedRecordsUnchanged: true, remainingSessionRecords: 1 }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
