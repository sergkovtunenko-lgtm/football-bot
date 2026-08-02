import type { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { getYdbDriver } from './connection';

export const RESET_TABLES = [
  'outbox',
  'scheduled_actions',
  'processed_updates',
  'win_awards',
  'win_events',
  'team_members',
  'teams',
  'participants',
  'sessions',
  'players',
] as const;

export type ResetTable = typeof RESET_TABLES[number];
export type ResetCounts = Record<ResetTable, bigint>;

export interface ResetExecutor {
  count(table: ResetTable): Promise<bigint>;
  clear(table: ResetTable): Promise<void>;
}

export interface ResetResult {
  before: ResetCounts;
  after: ResetCounts;
}

export async function resetWithExecutor(executor: ResetExecutor): Promise<ResetResult> {
  const before = await countTables(executor);
  for (const table of RESET_TABLES) await executor.clear(table);
  const after = await countTables(executor);
  if (Object.values(after).some((count) => count !== 0n)) {
    throw new Error('Production reset verification failed');
  }
  return { before, after };
}

export async function resetProductionState(driver: Driver): Promise<ResetResult> {
  const sql = query(driver);
  try {
    return await resetWithExecutor({
      count: async (table) => {
        const [rows] = await sql<[{ row_count: bigint }]>`
          ${sql.unsafe(`SELECT COUNT(*) AS row_count FROM ${table}`)}
        `.idempotent(true);
        return rows[0]?.row_count ?? 0n;
      },
      clear: async (table) => {
        await sql`${sql.unsafe(`DELETE FROM ${table}`)}`.idempotent(true);
      },
    });
  } finally {
    await sql[Symbol.asyncDispose]();
  }
}

async function countTables(executor: ResetExecutor): Promise<ResetCounts> {
  const entries: Array<[ResetTable, bigint]> = [];
  for (const table of RESET_TABLES) entries.push([table, await executor.count(table)]);
  return Object.fromEntries(entries) as ResetCounts;
}

async function main(): Promise<void> {
  const connectionString = process.env.YDB_CONNECTION_STRING;
  if (!connectionString) throw new Error('YDB_CONNECTION_STRING is required');
  const driver = await getYdbDriver(connectionString);
  try {
    const result = await resetProductionState(driver);
    for (const table of RESET_TABLES) {
      process.stdout.write(`${table}: ${result.before[table]} -> ${result.after[table]}\n`);
    }
  } finally {
    driver.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown reset error';
    console.error(`YDB production reset failed: ${message}`);
    process.exitCode = 1;
  });
}
