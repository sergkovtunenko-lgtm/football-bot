import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(__dirname, '../..');
const deployPath = resolve(repositoryRoot, 'scripts/deploy.ps1');
const helperPath = resolve(repositoryRoot, 'scripts/deploy-helpers.ps1');
const deploySource = readFileSync(deployPath, 'utf8');

describe('deploy safety contract', () => {
  it('validates the bot token before the first yc lookup', () => {
    const validation = deploySource.indexOf("if ($BotToken -notmatch");
    const firstYcLookup = deploySource.indexOf("Invoke-YcText @('config', 'get', 'folder-id')");
    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeLessThan(firstYcLookup);
  });

  it('normalizes multi-admin IDs before building the yc environment map', () => {
    expect(deploySource).toContain('$RuntimeAdminIds = ConvertTo-RuntimeAdminIds $AdminIds');
    expect(deploySource).toContain('ADMIN_IDS=$RuntimeAdminIds');
    expect(deploySource).not.toContain('ADMIN_IDS=$AdminIds,YDB_CONNECTION_STRING');
  });

  it('prints rollback instructions before moving stable and repeats them on later failure', () => {
    const firstRollback = deploySource.indexOf('Rollback: yc serverless function version set-tag');
    const stableMove = deploySource.indexOf("'--tag', 'stable') 'Stable tag update'");
    const failureHandler = deploySource.indexOf('catch {\n    if ($StableMoved)');
    const repeatedRollback = deploySource.indexOf(
      'Rollback: yc serverless function version set-tag',
      failureHandler,
    );
    expect(firstRollback).toBeGreaterThan(-1);
    expect(firstRollback).toBeLessThan(stableMove);
    expect(deploySource).toContain('$StableMoved = $true');
    expect(failureHandler).toBeGreaterThan(stableMove);
    expect(repeatedRollback).toBeGreaterThan(failureHandler);
  });

  it('converges and verifies the exact safe YDB serverless configuration', () => {
    expect(deploySource).toContain("@('ydb', 'database', 'update', $DatabaseName, '--serverless', '--sls-provisioned-rcu', '0', '--sls-storage-size', '1GB', '--deletion-protection')");
    expect(deploySource).toContain('Assert-YdbDatabaseConfiguration $Database');
  });
});

describe.skipIf(process.platform !== 'win32')('deploy PowerShell helpers', () => {
  const escapedHelperPath = helperPath.replaceAll("'", "''");

  it('preserves every admin ID using a map-safe separator', () => {
    const command = `. '${escapedHelperPath}'; ConvertTo-RuntimeAdminIds '111,222,-333'`;
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' }).trim();
    expect(output).toBe('111;222;-333');
  });

  it('accepts only the exact expected YDB configuration', () => {
    const database = JSON.stringify({
      endpoint: 'grpcs://example',
      deletion_protection: true,
      serverless_database: {
        provisioned_rcu_limit: '0',
        storage_size_limit: '1073741824',
      },
    }).replaceAll("'", "''");
    const command = `. '${escapedHelperPath}'; $database = '${database}' | ConvertFrom-Json; Assert-YdbDatabaseConfiguration $database; 'valid'`;
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' }).trim();
    expect(output).toBe('valid');
  });

  it('treats an omitted proto3 provisioned RCU field as zero', () => {
    const database = JSON.stringify({
      endpoint: 'grpcs://example',
      deletion_protection: true,
      serverless_database: {
        storage_size_limit: '1073741824',
      },
    }).replaceAll("'", "''");
    const command = `. '${escapedHelperPath}'; $database = '${database}' | ConvertFrom-Json; Assert-YdbDatabaseConfiguration $database; 'valid'`;
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' }).trim();
    expect(output).toBe('valid');
  });

  it('rejects an explicitly paid provisioned RCU configuration', () => {
    const database = JSON.stringify({
      endpoint: 'grpcs://example',
      deletion_protection: true,
      serverless_database: {
        provisioned_rcu_limit: '10',
        storage_size_limit: '1073741824',
      },
    }).replaceAll("'", "''");
    const command = `. '${escapedHelperPath}'; $database = '${database}' | ConvertFrom-Json; Assert-YdbDatabaseConfiguration $database`;
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('provisioned RCU limit is not 0');
  });
});
