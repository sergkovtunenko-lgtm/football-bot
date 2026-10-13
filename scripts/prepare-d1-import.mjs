import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';

const require = createRequire(import.meta.url);
const { recordsFromYdbSnapshot } = require('../dist/adapters/d1/import.js');
const { D1FootballStore } = require('../dist/adapters/d1/store.js');
const { buildLeaderboard } = require('../dist/domain/scoring.js');
const input = resolve(process.argv[2] ?? '.artifacts/migration/ydb-snapshot.json');
const snapshot = JSON.parse(await readFile(input, 'utf8'));
const records = recordsFromYdbSnapshot(snapshot);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const inserts = [];
for (let start = 0; start < records.length; start += 25) {
  const rows = records.slice(start, start + 25).map((record) =>
    `(${[record.kind, record.id, record.scope, record.status, record.payload].map(quote).join(',')})`);
  inserts.push(`INSERT INTO bot_records (kind,id,scope,status,payload) VALUES ${rows.join(',')};`);
}
const canonical = (items) => JSON.stringify([...items].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)));
const hash = createHash('sha256').update(canonical(records)).digest('hex');
inserts.push(`UPDATE bot_revision SET revision=1, commit_id=${quote(`ydb-import:${hash}`)} WHERE id=1 AND revision=0;`);
const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}',
  d1Databases: ['DB'], compatibilityDate: '2026-07-27' });
try {
  const db = await mf.getD1Database('DB');
  const schema = await readFile(resolve('migrations/d1/0001.sql'), 'utf8');
  await db.batch(schema.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
  await db.batch(inserts.map((sql) => db.prepare(sql)));
  const { results: imported } = await db.prepare('SELECT kind,id,scope,status,payload FROM bot_records').all();
  if (canonical(imported) !== canonical(records)) throw new Error('Imported records differ');
  const store = new D1FootballStore(db);
  const data = await store.transact(async (tx) => ({
    events: await tx.listWinEvents(), awards: await tx.listWinAwards(), completed: await tx.listCompletedSessionIds(),
    players: await tx.listPlayers(),
  }));
  const members = [];
  for (const session of snapshot.tables.sessions) members.push(...await store.transact((tx) => tx.listTeamMembers(session.session_id)));
  const leaderboard = buildLeaderboard(data.events, data.awards, data.completed, members,
    new Map(data.players.map((player) => [player.telegramUserId, player])));
  const completed = new Set(snapshot.tables.sessions.filter((s) => s.status === 'finished').map((s) => s.session_id));
  const activeWins = new Set(snapshot.tables.win_events.filter((e) => e.reversed_at === null && completed.has(e.session_id))
    .map((e) => `${e.session_id}:${e.ordinal}`));
  // Independent tally from the original YDB rows, before the adapter's conversion.
  for (const player of snapshot.tables.players) {
    const wins = snapshot.tables.win_awards.filter((a) => a.telegram_user_id === player.telegram_user_id
      && activeWins.has(`${a.session_id}:${a.win_ordinal}`)).length;
    const evenings = new Set(snapshot.tables.team_members.filter((p) => p.telegram_user_id === player.telegram_user_id
      && p.kind === 'player' && completed.has(p.session_id)).map((p) => p.session_id)).size;
    const result = leaderboard.find((p) => p.telegramUserId === player.telegram_user_id);
    if ((result?.wins ?? 0) !== wins || (result?.evenings ?? 0) !== evenings) throw new Error('Statistics changed during import');
  }
  if ((await store.getOperationalStatus()).pendingEffectCount !== snapshot.tables.outbox
    .filter((e) => e.status === 'pending' || e.status === 'leased').length) throw new Error('Outbox delivery status changed');
  const output = resolve('.artifacts/migration/d1-import.sql');
  await writeFile(output, inserts.join('\n'), { flag: 'wx' });
  const report = { recordCount: records.length, recordSha256: hash,
    counts: Object.fromEntries([...new Set(records.map((r) => r.kind))].map((kind) => [kind, records.filter((r) => r.kind === kind).length])),
    statisticsVerified: true, leaderboardPlayers: leaderboard.length, pendingEffects: (await store.getOperationalStatus()).pendingEffectCount };
  await writeFile(resolve('.artifacts/migration/verified-import.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report));
} finally { await mf.dispose(); }
