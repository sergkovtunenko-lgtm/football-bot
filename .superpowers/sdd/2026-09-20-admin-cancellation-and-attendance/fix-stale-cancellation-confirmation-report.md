# Stale cancellation confirmation fix report

Date: 2026-09-21

Implementation commit message: `fix: reject stale cancellation confirmations`

## Finding and root cause

The `/cancel` confirmation text named the weekly session, but its only button
used the static payload `v1:c:confirm`. The router therefore had no session
identity to compare with the current cycle. An administrator could press an
old confirmation after a new cycle started and invoke `cancelCurrentSession`,
which always targets the new current session.

## Minimal fix

- `cancellationConfirmationKeyboard(sessionId)` now emits
  `v1:c:YYYY-MM-DD`.
- The router parses that exact versioned form and, before any business-state
  change, compares its session id with `service.status().sessionId`.
- A mismatch returns the existing safe stale-action alert and never calls
  `cancelCurrentSession`.
- The existing configured-group and administrator checks are unchanged.
- `v1:c:YYYY-MM-DD` is 15 bytes, remaining well below Telegram's 64-byte
  callback limit; the renderer test continues to enforce the limit.

The legacy static payload is intentionally not accepted: accepting it would
retain the unsafe, unbound action.

## TDD evidence

Added `rejects a cancellation confirmation from an older weekly session` in
`tests/application/update-router.test.ts`. It supplies
`v1:c:2026-07-17` while the mocked current session is `2026-07-24` and asserts
both that the cancellation service is not called and that Telegram receives
`Эта кнопка уже неактуальна` as an alert.

### RED

Before production changes:

```text
npm test -- tests/application/update-router.test.ts
1 failed, 67 passed
received: "Кнопка не поддерживается"
expected: "Эта кнопка уже неактуальна"
```

### GREEN

After the session-bound callback and freshness check:

```text
npm test -- tests/application/update-router.test.ts tests/telegram/render.test.ts
2 files passed, 80 tests passed
```

## Final verification

```text
npm test
22 files passed, 1 skipped; 338 tests passed, 14 skipped
```

The 14 skipped tests are the existing optional YDB integration tests; the run
reported that `YDB_TEST_CONNECTION_STRING` is absent.

```text
npm run typecheck
exit 0

git diff --check
exit 0
```

No deployment, external API call, or data mutation was performed.

## Changed files

- `src/adapters/telegram/render.ts`
- `src/application/update-router.ts`
- `tests/application/update-router.test.ts`
- `tests/telegram/render.test.ts`
