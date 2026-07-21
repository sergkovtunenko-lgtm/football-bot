import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { Timestamp, Uint32 } from '@ydbjs/value/primitive';
import { getYdbDriver } from './connection';

const MIGRATION_PATH = resolve(__dirname, '../../../migrations/001_initial.sql');
const STATEMENT_BREAK = '-- statement-break';

export async function runMigrations(driver: Driver): Promise<void> {
  const migration = await readFile(MIGRATION_PATH, 'utf8');
  const statements = migration.split(STATEMENT_BREAK).map((statement) => statement.trim()).filter(Boolean);
  const sql = query(driver);
  try {
    for (const statement of statements) {
      await sql`${sql.unsafe(statement)}`.idempotent(true);
    }
    await sql`
      UPSERT INTO schema_migrations (version, applied_at)
      VALUES (${new Uint32(1)}, ${new Timestamp(new Date())})
    `.idempotent(true);
  } finally {
    await sql[Symbol.asyncDispose]();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.YDB_CONNECTION_STRING;
  if (!connectionString) throw new Error('YDB_CONNECTION_STRING is required');
  const driver = await getYdbDriver(connectionString);
  try {
    await runMigrations(driver);
  } finally {
    driver.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown migration error';
    console.error(`YDB migration failed: ${message}`);
    process.exitCode = 1;
  });
}
