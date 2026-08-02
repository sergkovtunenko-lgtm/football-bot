# Cloudflare Egress and Clean Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all outgoing Telegram Bot API calls through the existing Cloudflare Worker, remove reminder publications, and reset production game data so the first real cycle opens with one pinned card on Tuesday, 4 August 2026 at 10:00 Moscow.

**Architecture:** The current Worker keeps its durable Telegram ingress and gains a secret-protected `/telegram-api/<method>` egress route with a strict method allowlist. Yandex uses that route through a configurable Telegram client while YDB remains the source of truth and its outbox remains responsible for retries. A one-shot reset command deletes only game and delivery data, preserving the configured group and schema version.

**Tech Stack:** Node.js 22, TypeScript 7, Vitest 4, Cloudflare Workers/Queues, Yandex Cloud Functions, YDB Serverless, PowerShell deployment scripts.

## Global Constraints

- Do not send, edit, pin, unpin, or delete anything in the production Telegram group during implementation or verification.
- Delete all existing players, sessions, participants, teams, team members, wins, awards, processed updates, scheduled actions, and outbox effects.
- Preserve `settings` and `schema_migrations`.
- Store `BOT_TOKEN` only as platform secrets; never print it or commit it.
- Automatic schedule is Tuesday 10:00 open and Friday 20:55 close in `Europe/Moscow`; there are no reminder publications.
- The Tuesday opening creates at most one card, saves its message ID, pins it silently, and later button presses edit that card.
- Tests and read-only probes must not touch the production group.

---

## File Map

- `src/domain/schedule.ts`: due and next automatic actions; only `open | close` remain.
- `src/application/scheduler.ts`: enqueue the registration card and close teams; no reminder branch.
- `src/application/update-router.ts`: remove `/remind` from accepted recovery commands.
- `src/ports/store.ts`, `src/application/outbox-worker.ts`, `src/adapters/telegram/render.ts`: remove the unreachable reminder effect and renderer.
- `cloudflare/worker.mjs`: add the authenticated Telegram Bot API egress proxy.
- `src/config.ts`, `src/adapters/telegram/client.ts`, `src/handler.ts`: select and authenticate the Cloudflare Telegram endpoint.
- `scripts/deploy-cloudflare.ps1`, `scripts/deploy.ps1`: store `BOT_TOKEN`, probe `getMe`, and configure Yandex with the egress URL.
- `src/adapters/ydb/reset.ts`: one-shot, count-verified deletion of game tables only.
- `tests/**`: regression tests for all boundaries and deployment contracts.

---

### Task 1: Remove reminders and retain one canonical registration card

**Files:**
- Modify: `src/domain/schedule.ts`
- Modify: `src/application/scheduler.ts`
- Modify: `src/application/update-router.ts`
- Modify: `src/ports/store.ts`
- Modify: `src/application/outbox-worker.ts`
- Modify: `src/adapters/telegram/render.ts`
- Modify: `tests/domain/schedule.test.ts`
- Modify: `tests/application/scheduler.test.ts`
- Modify: `tests/application/update-router.test.ts`
- Modify: `tests/application/outbox-worker.test.ts`
- Modify: `tests/telegram/render.test.ts`

**Interfaces:**
- Produces: `ScheduleActionKind = 'open' | 'close'` and `nextScheduleAction()` that returns Friday close while registration is open.
- Preserves: registration effect `{ kind: 'registration_card'; sessionId: string }` and stored `registrationMessageId` edit-in-place behavior.

- [ ] **Step 1: Replace reminder expectations with no-reminder regression tests**

```ts
it('never emits reminder actions while registration is open', () => {
  for (const iso of ['2026-08-05T07:00:00Z', '2026-08-06T07:00:00Z', '2026-08-07T07:00:00Z']) {
    expect(due(iso, [], 'registration_open')).toEqual([]);
  }
});

it('reports Friday close as the next action for an open registration', () => {
  expect(nextScheduleAction(new Date('2026-08-04T07:01:00Z'), 'registration_open')).toEqual({
    kind: 'close',
    atIso: '2026-08-07T17:55:00.000Z',
  });
});
```

Also assert that `/remind` is not routed and that two ticks enqueue only one `registration_card` because the scheduled action key is idempotent.

- [ ] **Step 2: Run focused tests and confirm they fail on current reminder behavior**

Run: `npm test -- tests/domain/schedule.test.ts tests/application/scheduler.test.ts tests/application/update-router.test.ts tests/application/outbox-worker.test.ts tests/telegram/render.test.ts`

Expected: failures mention emitted `reminder` actions and accepted `/remind` behavior.

- [ ] **Step 3: Remove reminder code with no unrelated rendering changes**

```ts
export type ScheduleActionKind = 'open' | 'close';

function actionDueNow(local: DateTime, sessionId: string, status?: SessionStatus) {
  if (status === 'registration_open') {
    return isFridayCloseDue(local) ? action(sessionId, 'close') : undefined;
  }
  return (!status || status === 'scheduled') && isRegistrationWindow(local)
    ? action(sessionId, 'open')
    : undefined;
}
```

Delete the scheduler reminder branch, reminder effect, reminder renderer, and `/remind` command routing. Keep registration-card editing and its buttons unchanged.

- [ ] **Step 4: Run the focused tests**

Run: `npm test -- tests/domain/schedule.test.ts tests/application/scheduler.test.ts tests/application/update-router.test.ts tests/application/outbox-worker.test.ts tests/telegram/render.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/domain/schedule.ts src/application/scheduler.ts src/application/update-router.ts src/ports/store.ts src/application/outbox-worker.ts src/adapters/telegram/render.ts tests/domain/schedule.test.ts tests/application/scheduler.test.ts tests/application/update-router.test.ts tests/application/outbox-worker.test.ts tests/telegram/render.test.ts
git commit -m "feat: keep one weekly registration card"
```

---

### Task 2: Add the protected Cloudflare Telegram egress route

**Files:**
- Modify: `cloudflare/worker.mjs`
- Modify: `tests/cloudflare/worker.test.ts`

**Interfaces:**
- Consumes: `env.WEBHOOK_SECRET`, `env.BOT_TOKEN`, and request `POST /telegram-api/<method>`.
- Produces: transparent Telegram JSON/status response for `sendMessage`, `editMessageText`, `answerCallbackQuery`, `pinChatMessage`, and `getMe`.

- [ ] **Step 1: Write failing Worker proxy tests**

```ts
it('forwards an authenticated allowed method to Telegram without changing the body', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{"ok":true,"result":{"id":1}}', { status: 200 }));
  const worker = createWorker(fetcher);
  const response = await worker.fetch(telegramApiRequest('getMe', SECRET, '{}'), {
    ...environment(),
    BOT_TOKEN: '123456:bot-token-value',
  });
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.telegram.org/bot123456:bot-token-value/getMe',
    expect.objectContaining({ method: 'POST', redirect: 'manual', body: '{}' }),
  );
  expect(response.status).toBe(200);
});
```

Add cases for missing/wrong secret (`403`), non-POST (`405`), unknown method (`404`), invalid JSON (`400`), oversized body (`413`), missing/invalid Worker secrets (`503`), and an upstream redirect returned without following it.

- [ ] **Step 2: Run the Worker tests and confirm route failures**

Run: `npm test -- tests/cloudflare/worker.test.ts`

Expected: new `/telegram-api/getMe` requests return `404` and no Telegram fetch occurs.

- [ ] **Step 3: Implement a small isolated egress handler**

```js
const TELEGRAM_API_PREFIX = '/telegram-api/';
const ALLOWED_TELEGRAM_METHODS = new Set([
  'sendMessage', 'editMessageText', 'answerCallbackQuery', 'pinChatMessage', 'getMe',
]);

async function handleTelegramApi(request, env, fetcher, pathname) {
  const method = pathname.slice(TELEGRAM_API_PREFIX.length);
  if (!ALLOWED_TELEGRAM_METHODS.has(method)) return textResponse(404, 'not found');
  // Validate POST, secrets, size, and JSON before forwarding.
  return fetcher(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
    body: rawBody, signal: AbortSignal.timeout(20_000),
  });
}
```

Route `/telegram` to the unchanged ingress handler and `/telegram-api/*` to this function. Never include `BOT_TOKEN` in an error response.

- [ ] **Step 4: Run Worker tests and dry-run packaging**

Run: `npm test -- tests/cloudflare/worker.test.ts`

Run: `npm run cloudflare:dry-run`

Expected: both commands succeed.

- [ ] **Step 5: Commit**

```powershell
git add cloudflare/worker.mjs tests/cloudflare/worker.test.ts
git commit -m "feat: proxy Telegram API through Cloudflare"
```

---

### Task 3: Route the Yandex Telegram client through Cloudflare

**Files:**
- Modify: `src/config.ts`
- Modify: `src/adapters/telegram/client.ts`
- Modify: `src/handler.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/telegram/client.test.ts`

**Interfaces:**
- Produces: `AppConfig.telegramApiBaseUrl: string` from required `TELEGRAM_API_BASE_URL`.
- Produces: `new TelegramClient(token, fetcher, sleep, apiBaseUrl, gatewaySecret)`.
- Consumes: same `WEBHOOK_SECRET` as the gateway authorization value.

- [ ] **Step 1: Write failing config and client tests**

```ts
it('uses the configured gateway without putting the bot token in its URL', async () => {
  const fetcher = vi.fn().mockResolvedValue(ok({ message_id: 7 }));
  const client = new TelegramClient(
    'secret-token', fetcher, vi.fn(),
    'https://worker.example/telegram-api', 'gateway_secret_123456',
  );
  await client.sendMessage('-100', 'text');
  expect(fetcher.mock.calls[0]![0]).toBe('https://worker.example/telegram-api/sendMessage');
  expect(fetcher.mock.calls[0]![0]).not.toContain('secret-token');
  expect(fetcher.mock.calls[0]![1].headers).toMatchObject({
    'x-telegram-bot-api-secret-token': 'gateway_secret_123456',
  });
});
```

Add config cases for required HTTPS `TELEGRAM_API_BASE_URL`, rejection of credentials/query/hash, and silent pin payload `disable_notification: true`.

- [ ] **Step 2: Run focused tests and confirm missing config/constructor behavior**

Run: `npm test -- tests/config.test.ts tests/telegram/client.test.ts tests/handler.test.ts`

Expected: gateway URL/header and required config assertions fail.

- [ ] **Step 3: Implement validated gateway configuration and client URL construction**

```ts
const telegramApiBaseUrl = required(env, 'TELEGRAM_API_BASE_URL');
const parsed = new URL(telegramApiBaseUrl);
if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
  throw new Error('Invalid TELEGRAM_API_BASE_URL');
}
```

Use `${apiBaseUrl.replace(/\/$/, '')}/${method}` and attach the gateway secret header. Keep existing retry, timeout, response parsing, and token redaction. Set `disable_notification: true` inside `pinMessage`.

- [ ] **Step 4: Pass the config from production initialization and rerun focused tests**

```ts
const telegram = new TelegramClient(
  config.botToken,
  createRetryAfterPreservingFetcher((input, init) => globalThis.fetch(input, init)),
  undefined,
  config.telegramApiBaseUrl,
  config.webhookSecret,
);
```

Run: `npm test -- tests/config.test.ts tests/telegram/client.test.ts tests/handler.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/config.ts src/adapters/telegram/client.ts src/handler.ts tests/config.test.ts tests/telegram/client.test.ts tests/handler.test.ts
git commit -m "feat: use Cloudflare for Telegram delivery"
```

---

### Task 4: Make deployment secret-safe and probe Cloudflare with `getMe`

**Files:**
- Modify: `scripts/deploy-cloudflare.ps1`
- Modify: `scripts/deploy.ps1`
- Modify: `tests/scripts/deploy.test.ts`

**Interfaces:**
- Cloudflare secret bulk consumes `BOT_TOKEN`, `WEBHOOK_SECRET`, `YANDEX_FUNCTION_URL`.
- Yandex environment adds `TELEGRAM_API_BASE_URL=https://friday-football-bot-ingress.football-sergei.workers.dev/telegram-api`.
- `Invoke-TelegramGatewayProbe` performs only `getMe`; it accepts no chat ID and cannot publish.

- [ ] **Step 1: Change deployment contract tests first**

```ts
expect(cloudflareDeploySource).toContain("Require-EnvironmentValue 'BOT_TOKEN'");
expect(cloudflareDeploySource).toContain('BOT_TOKEN = $BotToken');
expect(deploySource).toContain('TELEGRAM_API_BASE_URL=$CloudflareTelegramApiUrl');
expect(cloudflareDeploySource).toContain("'/telegram-api/getMe'");
expect(cloudflareDeploySource).not.toContain('sendMessage');
```

Retain assertions that all Wrangler output is discarded and `$SecretsJson`/`$BotToken` are cleared in `finally` blocks.

- [ ] **Step 2: Run deployment tests and confirm failures**

Run: `npm test -- tests/scripts/deploy.test.ts`

Expected: missing BOT token secret and gateway environment assertions fail.

- [ ] **Step 3: Update Cloudflare deployment and rollback secret restoration**

```powershell
function Set-WorkerSecrets {
    param($WebhookSecret, $YandexFunctionUrl, $BotToken)
    $SecretsJson = @{
        WEBHOOK_SECRET = $WebhookSecret
        YANDEX_FUNCTION_URL = $YandexFunctionUrl
        BOT_TOKEN = $BotToken
    } | ConvertTo-Json -Compress
    $SecretsJson | & $Wrangler secret bulk *> $null
}
```

Add the authenticated `getMe` probe after Worker deployment. Do not log response content, token, headers, or URL containing the token.

- [ ] **Step 4: Add the gateway URL to candidate Yandex versions and rerun tests**

```powershell
$CloudflareTelegramApiUrl = 'https://friday-football-bot-ingress.football-sergei.workers.dev/telegram-api'
$Environment = "BOT_TOKEN=$BotToken,WEBHOOK_SECRET=$WebhookSecret,ADMIN_IDS=$RuntimeAdminIds,YDB_CONNECTION_STRING=$YdbConnectionString,YDB_METADATA_CREDENTIALS=1,TELEGRAM_API_BASE_URL=$CloudflareTelegramApiUrl"
```

Run: `npm test -- tests/scripts/deploy.test.ts`

Run: `powershell -NoProfile -Command "[void][scriptblock]::Create((Get-Content -Raw scripts/deploy.ps1)); [void][scriptblock]::Create((Get-Content -Raw scripts/deploy-cloudflare.ps1))"`

Expected: tests and syntax validation succeed.

- [ ] **Step 5: Commit**

```powershell
git add scripts/deploy.ps1 scripts/deploy-cloudflare.ps1 tests/scripts/deploy.test.ts
git commit -m "feat: deploy Telegram egress securely"
```

---

### Task 5: Add an explicit, verified production reset command

**Files:**
- Create: `src/adapters/ydb/reset.ts`
- Create: `tests/adapters/ydb/reset.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `RESET_TABLES`, exactly ten game/delivery tables and no technical table.
- Produces: `resetProductionState(driver): Promise<{ before: Record<string, bigint>; after: Record<string, bigint> }>`.
- CLI consumes `YDB_CONNECTION_STRING` plus standard YDB environment credentials and prints counts only.

- [ ] **Step 1: Write a failing reset-scope test**

```ts
expect(RESET_TABLES).toEqual([
  'outbox', 'scheduled_actions', 'processed_updates', 'win_awards', 'win_events',
  'team_members', 'teams', 'participants', 'sessions', 'players',
]);
expect(RESET_TABLES).not.toContain('settings');
expect(RESET_TABLES).not.toContain('schema_migrations');
```

Use an injected query executor in a second test to assert that each table is counted, deleted in dependency-safe order, counted again, and that a nonzero post-delete count throws `Production reset verification failed`.

- [ ] **Step 2: Run the reset test and confirm the module is absent**

Run: `npm test -- tests/adapters/ydb/reset.test.ts`

Expected: test fails because `src/adapters/ydb/reset.ts` does not exist.

- [ ] **Step 3: Implement count-delete-count with a testable executor**

```ts
export const RESET_TABLES = [
  'outbox', 'scheduled_actions', 'processed_updates', 'win_awards', 'win_events',
  'team_members', 'teams', 'participants', 'sessions', 'players',
] as const;

export async function resetProductionState(driver: Driver) {
  const sql = query(driver);
  try {
    const before = await counts(sql, RESET_TABLES);
    for (const table of RESET_TABLES) await sql`${sql.unsafe(`DELETE FROM ${table}`)}`;
    const after = await counts(sql, RESET_TABLES);
    if (Object.values(after).some((count) => count !== 0n)) {
      throw new Error('Production reset verification failed');
    }
    return { before, after };
  } finally {
    await sql[Symbol.asyncDispose]();
  }
}
```

The CLI prints only `table: before -> after`, closes the driver, and exits nonzero on failure. Add `"reset:production": "node dist/adapters/ydb/reset.js"`.

- [ ] **Step 4: Run reset tests, typecheck, and build**

Run: `npm test -- tests/adapters/ydb/reset.test.ts`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all commands succeed.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/ydb/reset.ts tests/adapters/ydb/reset.test.ts package.json
git commit -m "feat: add verified production reset"
```

---

### Task 6: Full verification, deployment, and zero-state proof

**Files:**
- Verify: all tracked source and tests
- Produce locally: `.artifacts/function.zip` (ignored build artifact)
- Change externally: Cloudflare Worker secrets/version, Yandex candidate/stable tag, YDB game rows

**Interfaces:**
- Consumes platform credentials already configured on this computer and process environment secrets.
- Produces a stable Cloudflare/Yandex deployment and a zeroed game database; does not touch the Telegram group.

- [ ] **Step 1: Run the complete local verification suite**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run cloudflare:dry-run`

Expected: all tests pass; only credential-dependent YDB integration tests may remain explicitly skipped.

- [ ] **Step 2: Inspect the final diff and secret hygiene**

Run: `git diff --check`

Run: `git status --short`

Run: `git grep -n -E "[0-9]{8,12}:[A-Za-z0-9_-]{30,}" -- ':!package-lock.json'`

Expected: no whitespace errors, only intended changes, and no token match.

- [ ] **Step 3: Deploy Cloudflare first and run only safe probes**

Run the tested Cloudflare deployment with `BOT_TOKEN`, `WEBHOOK_SECRET`, and the stable Yandex URL available only as process environment variables. Confirm wrong secret returns `403`, ingress sentinel returns `200`, and egress `getMe` returns a successful Telegram envelope. Do not call any send/edit/pin method in this step.

- [ ] **Step 4: Build and deploy a Yandex candidate**

Package the function, create a Node.js 22 version with `TELEGRAM_API_BASE_URL` set to the Worker gateway, wait for `ACTIVE`, and tag it `candidate`. Probe only the authenticated HTTP handler using sentinel update `-1`; do not invoke the timer and do not submit a real Telegram update.

- [ ] **Step 5: Clear stale data before moving stable**

Temporarily authenticate to YDB with a short-lived IAM token and run `npm run reset:production`. Confirm all ten reported post-reset counts are zero and separately read `settings.group_chat_id` plus `schema_migrations.version` to prove both technical tables remain.

- [ ] **Step 6: Move stable and inspect automation read-only**

Move the `stable` tag to the active candidate. Read the timer trigger and confirm it remains active with one-minute cadence and invokes the `stable` tag. Read YDB again and confirm no outbox row was created on Sunday and all game tables remain empty.

- [ ] **Step 7: Commit any final test-only corrections and report**

```powershell
git status --short
git log -6 --oneline
```

Expected report: exact test counts, Cloudflare `getMe` success, active Yandex version ID, zero-state table counts, preserved settings/migration rows, and explicit confirmation that nothing was sent to the group.

