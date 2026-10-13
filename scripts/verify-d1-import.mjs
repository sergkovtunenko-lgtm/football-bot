import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { recordsFromYdbSnapshot } = require('../dist/adapters/d1/import.js');
const snapshot = JSON.parse(await readFile(resolve(process.argv[2] ?? '.artifacts/migration/ydb-snapshot.json'), 'utf8'));
const expected = recordsFromYdbSnapshot(snapshot);
const result = spawnSync(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute',
  'friday-football-bot-v2', '--config', 'wrangler.bot.jsonc', '--remote', '--json', '--command',
  'SELECT kind,id,scope,status,payload FROM bot_records;'], { encoding: 'utf8', timeout: 90_000, maxBuffer: 10 * 1024 * 1024 });
if (result.status !== 0) throw new Error('Remote D1 verification query failed');
const response = JSON.parse(result.stdout);
if (response[0]?.success !== true) throw new Error('Remote D1 verification query did not succeed');
const actual = response[0].results;
const canonical = (records) => JSON.stringify([...records].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)));
if (canonical(actual) !== canonical(expected)) throw new Error('Remote records differ from the YDB snapshot; do not activate');
console.log(JSON.stringify({ verified: true, recordCount: actual.length,
  recordSha256: createHash('sha256').update(canonical(actual)).digest('hex') }));
