import { describe, expect, it, vi } from 'vitest';
import {
  RESET_TABLES,
  resetWithExecutor,
  type ResetExecutor,
} from '../../../src/adapters/ydb/reset';

describe('production YDB reset', () => {
  it('contains every game table in dependency-safe order and no technical table', () => {
    expect(RESET_TABLES).toEqual([
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
    ]);
    expect(RESET_TABLES).not.toContain('settings');
    expect(RESET_TABLES).not.toContain('schema_migrations');
  });

  it('counts, clears, recounts, and returns only row counts', async () => {
    const rows = new Map(RESET_TABLES.map((table, index) => [table, BigInt(index + 1)]));
    const executor: ResetExecutor = {
      count: vi.fn(async (table) => rows.get(table) ?? 0n),
      clear: vi.fn(async (table) => { rows.set(table, 0n); }),
    };

    const result = await resetWithExecutor(executor);

    expect(executor.clear).toHaveBeenCalledTimes(RESET_TABLES.length);
    expect(vi.mocked(executor.clear).mock.calls.map(([table]) => table)).toEqual(RESET_TABLES);
    expect(Object.values(result.before).every((count) => count > 0n)).toBe(true);
    expect(Object.values(result.after).every((count) => count === 0n)).toBe(true);
  });

  it('fails verification when any table remains nonempty', async () => {
    let cleared = false;
    const executor: ResetExecutor = {
      count: vi.fn(async (table) => cleared && table !== 'players' ? 0n : 1n),
      clear: vi.fn(async () => { cleared = true; }),
    };

    await expect(resetWithExecutor(executor)).rejects.toThrow(
      'Production reset verification failed',
    );
  });
});
