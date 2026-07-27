# Task 11 YDB deletion-protection live-fix report

Date: 2026-07-27

Implementation commit: `0985ca9` (`fix: enforce YDB deletion protection via REST`)

## Scope and root cause

The live deployment was not run.

The existing deployment correctly stopped at `Assert-YdbDatabaseConfiguration` because deletion protection remained disabled. Live evidence established that Yandex Cloud CLI 1.18.0 returned exit code 0 for both `yc ydb database update ... --deletion-protection` and the `ydb v0` form without changing the database. The official REST PATCH with `updateMask: deletionProtection` did change the resource.

The fix retains the CLI convergence for serverless mode, 0 provisioned RCU, and the 1 GB storage limit. It then:

1. obtains a short-lived IAM token;
2. PATCHes only `deletionProtection` through the official YDB REST endpoint;
3. polls the returned operation until completion, treating omitted protobuf `done: false` as pending;
4. throws fixed, secret-safe errors for operation and transport failures;
5. re-reads the database through the official REST endpoint and requires `deletionProtection: true`;
6. clears the short-lived token reference;
7. re-reads through `yc` and runs the unchanged `Assert-YdbDatabaseConfiguration` for the full safe configuration.

HTTP clients, requests, and responses are disposed in `finally`. Authorization headers, IAM tokens, database IDs, operation IDs, provider response bodies, and raw transport exceptions are never emitted by the new code.

## TDD evidence

The first test attempt could not start because the fresh temporary worktree had no dependencies:

```text
npm.cmd test -- tests/scripts/deploy.test.ts
exit 1: 'vitest' is not recognized
```

`npm.cmd ci` completed successfully after installing 120 packages. It emitted the existing engine warning that the repository requests Node 22 while the machine currently provides Node 24.14.1.

### RED 1: executable PATCH, wait, and re-read behavior

Command:

```text
npm.cmd test -- tests/scripts/deploy.test.ts -t "enables YDB deletion protection through REST"
```

Expected RED, exit 1:

```text
Set-YdbDeletionProtectionViaRest is not recognized
expected three requests, received []
```

Focused GREEN after the minimal helper implementation:

```text
Test Files 1 passed
Tests 1 passed | 8 skipped
```

### RED 2: sanitized operation failure

Command:

```text
npm.cmd test -- tests/scripts/deploy.test.ts -t "reports an operation failure"
```

Expected RED, exit 1:

```text
expected: YDB deletion-protection update operation failed.
received: YDB deletion protection is not enabled after REST update.
```

Focused GREEN after adding the operation-error branch:

```text
Test Files 1 passed
Tests 1 passed | 9 skipped
```

The test injects fake provider details and identifiers and verifies that none appears in the thrown message.

### RED 3: omitted protobuf `done: false`

Command:

```text
npm.cmd test -- tests/scripts/deploy.test.ts -t "enables YDB deletion protection through REST"
```

Expected RED, exit 1:

```text
YDB deletion-protection update returned an invalid operation status.
```

Focused GREEN after interpreting an omitted `done` field as a pending operation:

```text
Test Files 1 passed
Tests 1 passed | 9 skipped
```

### RED 4: secret-safe real transport boundary

Command:

```text
npm.cmd test -- tests/scripts/deploy.test.ts -t "sanitizes transport failures"
```

Expected RED, exit 1:

```text
expected: Yandex Cloud REST request failed before receiving a response.
received: raw HttpClient exception
```

This RED also exposed PowerShell coercing a null GET body to an empty string. The minimal implementation keeps the body as null and wraps transport exceptions in a fixed message.

Focused GREEN:

```text
Test Files 1 passed
Tests 1 passed | 10 skipped
```

### Deploy wiring

The secondary source contract was RED before `deploy.ps1` obtained the REST IAM token and invoked the tested helper, then GREEN after wiring. The executable helper tests above carry the request-body, polling, final read, and error behavior.

## Final verification

```text
npm.cmd test -- tests/scripts/deploy.test.ts
Test Files 1 passed
Tests 11 passed
```

```text
npm.cmd test
Test Files 17 passed | 1 skipped
Tests 226 passed | 11 skipped
```

```text
npm.cmd run test:coverage
Test Files 17 passed | 1 skipped
Tests 226 passed | 11 skipped
Statements 92.64%, Branches 85.11%, Functions 93.12%, Lines 94.74%
```

```text
npm.cmd run typecheck
exit 0
```

```text
npm.cmd run build
exit 0
```

```text
PowerShell parser check for scripts/deploy.ps1 and scripts/deploy-helpers.ps1
PowerShell parse OK
```

```text
git diff --check
exit 0
```

The full suite's optional live YDB integration test was skipped because `YDB_TEST_CONNECTION_STRING` was absent. No live deployment or cloud mutation was performed.

## Files

- `scripts/deploy-helpers.ps1`: official REST request boundary, deletion-protection operation polling, final REST validation, resource disposal, and sanitized errors.
- `scripts/deploy.ps1`: short-lived IAM token lifecycle, REST enforcement call, final `yc` re-read, and unchanged full configuration assertion.
- `tests/scripts/deploy.test.ts`: executable PowerShell behavior tests, deploy wiring contract, and a line-ending-safe pre-existing rollback lookup.

## Concerns

- Production deployment remains intentionally unexecuted.
- The optional live YDB integration test requires `YDB_TEST_CONNECTION_STRING` and was not run.
- Verification used Node 24.14.1 although `package.json` declares Node 22; all local tests, coverage, typecheck, and build nevertheless passed.

## Round 2: malformed operation response containment

Review found that a null PATCH response reached `$Operation.PSObject.Properties['id']` under production StrictMode and emitted a raw PowerShell exception. Empty objects and scalar responses also used a different missing-ID message, so malformed responses did not have one deterministic contract.

The executable regression test runs the real `Set-YdbDeletionProtectionViaRest` orchestration with only the external request boundary substituted. It supplies null, an empty object, and a scalar containing fake provider data.

### RED

Command:

```text
npm.cmd test -- tests/scripts/deploy.test.ts -t "reports malformed operation responses"
```

Expected RED, exit 1:

```text
received:
- Cannot index into a null array.
- YDB deletion-protection update returned an operation without an ID.
- YDB deletion-protection update returned an operation without an ID.

expected for every malformed response:
- YDB deletion-protection update returned a malformed operation.
```

### GREEN

The minimal guard now requires the PATCH result to be a structured REST JSON object with a non-empty operation ID. Every malformed result throws the same fixed message without provider data, IAM tokens, database IDs, or operation IDs. The valid `{id}` response with omitted protobuf `done: false` is unchanged and continues to poll.

```text
npm.cmd test -- tests/scripts/deploy.test.ts -t "reports malformed operation responses"
Test Files 1 passed
Tests 1 passed | 11 skipped
```

### Round 2 verification

```text
npm.cmd test -- tests/scripts/deploy.test.ts
Test Files 1 passed
Tests 12 passed
```

```text
PowerShell parser check for scripts/deploy-helpers.ps1
PowerShell parse OK
```

```text
npm.cmd run typecheck
exit 0
```

```text
npm.cmd run build
exit 0
```

No live deployment or cloud mutation was performed.
