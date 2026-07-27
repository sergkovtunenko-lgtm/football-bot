import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    const failureHandler = deploySource.indexOf('catch {', stableMove);
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
    expect(deploySource).toContain("$YdbRestIamToken = Invoke-YcText @('iam', 'create-token') 'Short-lived IAM token creation for YDB configuration'");
    expect(deploySource).toContain('Set-YdbDeletionProtectionViaRest -DatabaseId ([string]$Database.id) -IamToken $YdbRestIamToken');
    expect(deploySource).toContain('$YdbRestIamToken = $null');
    expect(deploySource).toContain('Assert-YdbDatabaseConfiguration $Database');
  });

  it('uses the tested yc JSON helper instead of shadowing it in the deploy script', () => {
    expect(deploySource).not.toContain('function Get-YcJsonOrNull');
  });
});

describe.skipIf(process.platform !== 'win32')('deploy PowerShell helpers', () => {
  const escapedHelperPath = helperPath.replaceAll("'", "''");
  const powerShellTestTimeout = 15_000;
  let fakeYcDirectory: string;
  let escapedFakeYcPath: string;

  beforeAll(() => {
    fakeYcDirectory = mkdtempSync(join(tmpdir(), 'football-bot-fake-yc-'));
    const fakeYcPath = join(fakeYcDirectory, 'yc.cmd');
    writeFileSync(fakeYcPath, [
      '@echo off',
      'if "%~1"=="success" (',
      '  echo {"id":"service-account-test"}',
      '  >&2 echo unable to rotate logs at C:\\sensitive\\yc.log: file in use',
      '  exit /b 0',
      ')',
      'if "%~1"=="not-found" (',
      '  echo lookup output contained sensitive-account-id',
      '  >&2 echo service account does not exist: sensitive-account-id',
      '  exit /b 1',
      ')',
      'echo lookup output contained sensitive-account-id',
      '>&2 echo permission denied for C:\\sensitive\\yc.log and sensitive-account-id',
      'exit /b 2',
      '',
    ].join('\r\n'), 'utf8');
    escapedFakeYcPath = fakeYcPath.replaceAll("'", "''");
  });

  afterAll(() => {
    rmSync(fakeYcDirectory, { recursive: true, force: true });
  });

  it('parses stdout JSON when yc exits zero despite a stderr warning', () => {
    const command = `
      . '${escapedHelperPath}'
      Get-YcJsonOrNull -Arguments @('success') -Description 'Service account lookup' -ExecutablePath '${escapedFakeYcPath}' |
        ConvertTo-Json -Compress
    `;
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' }).trim();

    expect(JSON.parse(output)).toEqual({ id: 'service-account-test' });
    expect(output).not.toContain('unable to rotate logs');
    expect(output).not.toContain('C:\\sensitive\\yc.log');
  }, powerShellTestTimeout);

  it('returns null for a nonzero yc not-found response without leaking diagnostics', () => {
    const command = `
      . '${escapedHelperPath}'
      $result = Get-YcJsonOrNull -Arguments @('not-found') -Description 'Service account lookup' -ExecutablePath '${escapedFakeYcPath}'
      if ($null -ne $result) { exit 9 }
      [Console]::Out.Write('null')
    `;
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toBe('null');
    expect(output).not.toContain('sensitive-account-id');
  }, powerShellTestTimeout);

  it('throws the fixed description for other nonzero yc failures without leaking diagnostics', () => {
    const command = `
      . '${escapedHelperPath}'
      try {
        Get-YcJsonOrNull -Arguments @('failure') -Description 'Service account lookup' -ExecutablePath '${escapedFakeYcPath}'
        exit 0
      }
      catch {
        [Console]::Out.Write($_.Exception.Message)
        exit 7
      }
    `;
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(7);
    expect(output).toBe('Service account lookup failed.');
    expect(output).not.toContain('permission denied');
    expect(output).not.toContain('C:\\sensitive\\yc.log');
    expect(output).not.toContain('sensitive-account-id');
  }, powerShellTestTimeout);

  it('preserves every admin ID using a map-safe separator', () => {
    const command = `. '${escapedHelperPath}'; ConvertTo-RuntimeAdminIds '111,222,-333'`;
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' }).trim();
    expect(output).toBe('111;222;-333');
  }, powerShellTestTimeout);

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
  }, powerShellTestTimeout);

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
  }, powerShellTestTimeout);

  it('enables YDB deletion protection through REST, waits, and re-reads the database', () => {
    const command = `
      . '${escapedHelperPath}'
      $responses = [Collections.Generic.Queue[object]]::new()
      $responses.Enqueue([pscustomobject]@{ id = 'operation-test-id' })
      $responses.Enqueue([pscustomobject]@{ id = 'operation-test-id'; done = $true; response = [pscustomobject]@{} })
      $responses.Enqueue([pscustomobject]@{ deletionProtection = $true })
      $requests = [Collections.Generic.List[object]]::new()
      $requestInvoker = {
        param($Method, $Uri, $IamToken, $BodyJson)
        [void]$requests.Add([pscustomobject]@{
          method = $Method
          uri = $Uri
          tokenMatched = $IamToken -eq 'test-iam-token'
          bodyJson = $BodyJson
        })
        return $responses.Dequeue()
      }
      $database = Set-YdbDeletionProtectionViaRest -DatabaseId 'database-test-id' -IamToken 'test-iam-token' -RequestInvoker $requestInvoker -DelayInvoker { param($Seconds) }
      [pscustomobject]@{ requests = $requests; database = $database } |
        ConvertTo-Json -Depth 10 -Compress
    `;
    const result = JSON.parse(execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' }).trim()) as {
      requests: Array<{
        method: string;
        uri: string;
        tokenMatched: boolean;
        bodyJson: string | null;
      }>;
      database: { deletionProtection: boolean };
    };

    const requests = result.requests.map(({ bodyJson, ...request }) => ({
      ...request,
      body: bodyJson === null ? null : JSON.parse(bodyJson) as unknown,
    }));
    expect(requests).toEqual([
      {
        method: 'PATCH',
        uri: 'https://ydb.api.cloud.yandex.net/ydb/v1/databases/database-test-id',
        tokenMatched: true,
        body: {
          updateMask: 'deletionProtection',
          deletionProtection: true,
        },
      },
      {
        method: 'GET',
        uri: 'https://operation.api.cloud.yandex.net/operations/operation-test-id',
        tokenMatched: true,
        body: null,
      },
      {
        method: 'GET',
        uri: 'https://ydb.api.cloud.yandex.net/ydb/v1/databases/database-test-id',
        tokenMatched: true,
        body: null,
      },
    ]);
    expect(result.database.deletionProtection).toBe(true);
  }, powerShellTestTimeout);

  it('reports an operation failure without exposing provider details or identifiers', () => {
    const command = `
      . '${escapedHelperPath}'
      $requestInvoker = {
        param($Method, $Uri, $IamToken, $BodyJson)
        return [pscustomobject]@{
          id = 'operation-sensitive-id'
          done = $true
          error = [pscustomobject]@{
            message = 'raw provider error with secret-iam-token-should-not-appear'
          }
        }
      }
      try {
        Set-YdbDeletionProtectionViaRest -DatabaseId 'database-sensitive-id' -IamToken 'secret-iam-token-should-not-appear' -RequestInvoker $requestInvoker
        exit 0
      }
      catch {
        [Console]::Out.Write($_.Exception.Message)
        exit 7
      }
    `;
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(7);
    expect(output).toBe('YDB deletion-protection update operation failed.');
    expect(output).not.toContain('raw provider error');
    expect(output).not.toContain('secret-iam-token-should-not-appear');
    expect(output).not.toContain('database-sensitive-id');
    expect(output).not.toContain('operation-sensitive-id');
  }, powerShellTestTimeout);

  it('reports malformed operation responses with one fixed safe message', () => {
    const command = `
      . '${escapedHelperPath}'
      $operationResponses = @(
        $null
        [pscustomobject]@{}
        'raw-provider-value-should-not-appear'
      )
      $messages = foreach ($operationResponse in $operationResponses) {
        $requestInvoker = {
          param($Method, $Uri, $IamToken, $BodyJson)
          return $operationResponse
        }
        try {
          Set-YdbDeletionProtectionViaRest -DatabaseId 'database-sensitive-id' -IamToken 'secret-iam-token-should-not-appear' -RequestInvoker $requestInvoker
          'unexpected success'
        }
        catch {
          $_.Exception.Message
        }
      }
      $messages | ConvertTo-Json -Compress
    `;
    const messages = JSON.parse(execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' }).trim()) as string[];
    const output = messages.join('\n');

    expect(messages).toEqual([
      'YDB deletion-protection update returned a malformed operation.',
      'YDB deletion-protection update returned a malformed operation.',
      'YDB deletion-protection update returned a malformed operation.',
    ]);
    expect(output).not.toContain('raw-provider-value-should-not-appear');
    expect(output).not.toContain('secret-iam-token-should-not-appear');
    expect(output).not.toContain('database-sensitive-id');
  }, powerShellTestTimeout);

  it('reports a malformed operation poll response with the fixed safe message', () => {
    const command = `
      . '${escapedHelperPath}'
      $malformedPollResponses = @(
        $null
        [pscustomobject]@{}
        'raw-provider-value-should-not-appear'
      )
      $messages = foreach ($malformedPollResponse in $malformedPollResponses) {
        $responses = [Collections.Generic.Queue[object]]::new()
        $responses.Enqueue([pscustomobject]@{ id = 'operation-sensitive-id' })
        $responses.Enqueue($malformedPollResponse)
        $requestInvoker = {
          param($Method, $Uri, $IamToken, $BodyJson)
          return $responses.Dequeue()
        }
        try {
          Set-YdbDeletionProtectionViaRest -DatabaseId 'database-sensitive-id' -IamToken 'secret-iam-token-should-not-appear' -RequestInvoker $requestInvoker -DelayInvoker { param($Seconds) }
          'unexpected success'
        }
        catch {
          $_.Exception.Message
        }
      }
      $messages | ConvertTo-Json -Compress
    `;
    const messages = JSON.parse(execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' }).trim()) as string[];
    const output = messages.join('\n');

    expect(messages).toEqual([
      'YDB deletion-protection update returned a malformed operation.',
      'YDB deletion-protection update returned a malformed operation.',
      'YDB deletion-protection update returned a malformed operation.',
    ]);
    expect(output).not.toContain('raw-provider-value-should-not-appear');
    expect(output).not.toContain('secret-iam-token-should-not-appear');
    expect(output).not.toContain('database-sensitive-id');
    expect(output).not.toContain('operation-sensitive-id');
  }, powerShellTestTimeout);

  it('sanitizes transport failures from the real REST request boundary', () => {
    const command = `
      Add-Type -AssemblyName System.Net.Http
      . '${escapedHelperPath}'
      try {
        Invoke-YandexCloudRestJsonRequest 'GET' 'http://127.0.0.1:1/databases/database-sensitive-id' 'secret-iam-token-should-not-appear' $null
        exit 0
      }
      catch {
        [Console]::Out.Write($_.Exception.Message)
        exit 7
      }
    `;
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(7);
    expect(output).toBe('Yandex Cloud REST request failed before receiving a response.');
    expect(output).not.toContain('secret-iam-token-should-not-appear');
    expect(output).not.toContain('database-sensitive-id');
  }, powerShellTestTimeout);

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
  }, powerShellTestTimeout);
});
