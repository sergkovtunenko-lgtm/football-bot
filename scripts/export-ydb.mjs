import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { getYdbDriver } = require('../dist/adapters/ydb/connection.js');
const { query } = require('@ydbjs/query');
const tables = ['settings', 'players', 'sessions', 'participants', 'teams', 'team_members',
  'win_events', 'win_awards', 'processed_updates', 'scheduled_actions', 'outbox'];

async function main() {
  const output = resolve(process.argv[2] ?? '.artifacts/migration/ydb-snapshot.json');
  if (!output.includes(`${resolve('.artifacts')}`)) throw new Error('Use a private .artifacts output path');
  const driver = await getYdbDriver(process.env.YDB_CONNECTION_STRING);
  const sql = query(driver);
  try {
    const snapshot = await sql.begin({ isolation: 'serializableReadWrite', idempotent: true }, async (tx) => {
      const result = {};
      for (const table of tables) {
        const [rows] = await tx`${sql.unsafe(`SELECT * FROM ${table}`)}`;
        result[table] = rows;
      }
      return result;
    });
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), tables: snapshot },
      (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, body, { flag: 'wx' });
    console.log(JSON.stringify({ output, sha256: createHash('sha256').update(body).digest('hex'),
      counts: Object.fromEntries(tables.map((name) => [name, snapshot[name].length])) }));
  } finally {
    await sql[Symbol.asyncDispose]();
    driver.close();
  }
}

main().catch(() => { console.error('YDB snapshot export failed; no data changed.'); process.exitCode = 1; });
