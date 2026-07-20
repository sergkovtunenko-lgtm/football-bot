# Friday Football Telegram Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, verify, and deploy a production Telegram bot for weekly Friday football registration, random team formation, one-tap team wins, and a cumulative personal leaderboard on Yandex Cloud Functions with YDB Serverless.

**Architecture:** A single Node.js 22 Cloud Function accepts signed Telegram webhooks and private Yandex Timer Trigger events. Pure TypeScript domain functions own registration, team, scoring, and schedule rules; application services execute them inside YDB serializable transactions and deliver critical Telegram effects through a retryable outbox. The function is stateless between calls, while all durable state and deduplication live in YDB.

**Tech Stack:** TypeScript 7, Node.js 22, Vitest 4, Luxon 3, `@ydbjs/core` 6.3.1, `@ydbjs/auth` 6.3.1, `@ydbjs/query` 6.3.0, Yandex Cloud Functions, YDB Serverless, Yandex Timer Trigger, GitHub Actions.

## Global Constraints

- Follow the approved spec at `docs/superpowers/specs/2026-07-21-football-bot-design.md` exactly.
- Use `Europe/Moscow` for product time and UTC only at the Yandex cron boundary.
- Open registration Tuesday 10:00; remind Wednesday, Thursday, and Friday 10:00; close Friday 20:55; play Friday 21:00.
- Limit the active list to 20 individual slots; keep overflow in a FIFO waitlist and promote atomically after cancellation.
- Create only complete teams of five, from two through four teams; spread remaining active players across team reserves with a difference of at most one.
- Do not choose match order, opponents, scores, losses, draws, MVP, or win percentage.
- A team win awards one cumulative win to every Telegram player assigned to that team, including team reserves; guests never enter the cumulative leaderboard.
- Treat Telegram `update_id`, schedule action keys, and session finalization as idempotency boundaries.
- Keep `BOT_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_IDS`, and cloud credentials out of Git and logs.
- Use exact file staging in every commit because the worktree contains unrelated legacy edits and deletions.
- Do not delete or overwrite the locally modified `bot.py` or untracked `football_cloudflare/` files.
- Target the current Yandex runtime `nodejs22`; do not use the retired polling process or GitHub Actions as hosting.
- Keep the expected monthly usage inside the current free tier: no prepared instances, provisioned YDB capacity, API Gateway, VM, paid queue, or Lockbox dependency.

## Reference Documentation

- Node.js 22 runtime and dependency handling: <https://yandex.cloud/ru/docs/functions/lang/nodejs/>
- Cloud Function Node.js handler: <https://yandex.cloud/en/docs/functions/lang/nodejs/handler>
- Timer event format and UTC cron: <https://yandex.cloud/ru/docs/functions/concepts/trigger/timer>
- Public function invocation: <https://yandex.cloud/ru/docs/functions/operations/function/function-public>
- Function version tags and tagged invocation: <https://yandex.cloud/ru/docs/functions/operations/function/tag-add> and <https://yandex.cloud/ru/docs/functions/operations/function/function-invoke>
- Timer trigger version targeting: <https://yandex.cloud/en/docs/cli/cli-ref/serverless/cli-ref/trigger/create/timer>
- Current YDB JS SDK connection and metadata credentials: <https://ydb.js.org/guide/core>
- Current YDB JS query and transaction API: <https://ydb.tech/docs/en/dev/example-app/example-js?version=v25.2>
- YDB `CREATE TABLE IF NOT EXISTS`: <https://ydb.tech/docs/en/yql/reference/syntax/create_table/>
- Telegram webhook security and update schema: <https://core.telegram.org/bots/api#setwebhook>

## Planned File Structure

```text
.
├── .github/workflows/ci.yml           # test/typecheck/build only
├── .gitignore                         # secrets, build output, packages
├── .nvmrc                             # Node 22
├── README.md                          # user setup and operations
├── migrations/001_initial.sql         # complete YDB schema
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── scripts/
│   ├── deploy.ps1                     # idempotent Yandex deployment
│   ├── package-function.ps1           # deterministic deployment zip
│   └── set-webhook.mjs                # set/get/delete webhook safely
├── src/
│   ├── application/
│   │   ├── bot-service.ts             # transactional user/admin use cases
│   │   ├── outbox-worker.ts           # Telegram retries and reconciliation
│   │   ├── scheduler.ts               # scheduled state transitions
│   │   ├── update-router.ts           # Telegram Update → use case
│   │   └── views.ts                   # query snapshots rendered by Telegram
│   ├── adapters/
│   │   ├── telegram/
│   │   │   ├── client.ts              # Bot API HTTP client
│   │   │   ├── render.ts              # safe HTML and keyboards
│   │   │   └── types.ts               # supported Update/API shapes
│   │   └── ydb/
│   │       ├── connection.ts           # cached metadata-authenticated driver
│   │       ├── migrate.ts              # schema runner
│   │       └── store.ts                # transactional repository
│   ├── domain/
│   │   ├── model.ts                    # domain types and invariants
│   │   ├── registration.ts             # party changes and FIFO reserve
│   │   ├── schedule.ts                 # Moscow weekly actions
│   │   ├── scoring.ts                  # awards, undo, leaderboard
│   │   └── teams.ts                    # random full teams and reserves
│   ├── ports/
│   │   ├── clock.ts
│   │   ├── random.ts
│   │   ├── store.ts
│   │   └── telegram.ts
│   ├── config.ts                       # strict environment parsing
│   ├── handler.ts                      # Yandex entrypoint
│   └── logger.ts                       # redacted structured logs
└── tests/
    ├── application/
    ├── domain/
    ├── integration/
    ├── telegram/
    └── support/
```

---

### Task 1: Establish the TypeScript runtime, configuration, and shared domain contracts

**Files:**
- Create: `.nvmrc`
- Create: `.gitignore`
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `src/config.ts`
- Create: `src/domain/model.ts`
- Create: `src/ports/clock.ts`
- Create: `src/ports/random.ts`
- Create: `src/logger.ts`
- Test: `tests/config.test.ts`
- Test: `tests/logger.test.ts`

**Interfaces:**
- Produces: `AppConfig`, `loadConfig(env)`, `Clock`, `RandomSource`, and all shared domain types consumed by every later task.
- Produces domain identifiers as strings so Telegram IDs never pass through unsafe JavaScript `number` conversion.

- [ ] **Step 1: Add the runtime and package manifest**

Create `.nvmrc` containing `22`. Create `package.json` with the exact scripts and pinned runtime dependencies:

```json
{
  "name": "friday-football-bot",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "migrate": "node dist/adapters/ydb/migrate.js"
  },
  "dependencies": {
    "@ydbjs/auth": "6.3.1",
    "@ydbjs/core": "6.3.1",
    "@ydbjs/query": "6.3.0",
    "luxon": "3.7.2"
  },
  "devDependencies": {
    "@types/luxon": "3.7.2",
    "@types/node": "22.20.1",
    "@vitest/coverage-v8": "4.1.10",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

Create `tsconfig.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmit: true`, CommonJS modules, and includes for `src/**/*.ts`, `tests/**/*.ts`, and `vitest.config.ts`. Create `tsconfig.build.json` extending it with `noEmit: false`, `rootDir: "src"`, `outDir: "dist"`, and an include containing only `src/**/*.ts`. Create `vitest.config.ts` with the Node environment, automatic mock restoration, and coverage thresholds of 90% statements/lines/functions and 85% branches.

Run:

```powershell
npm.cmd install
```

Expected: `package-lock.json` is created and installation exits with code 0.

- [ ] **Step 2: Write failing configuration tests**

Create `tests/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const valid = {
  BOT_TOKEN: '123456:secret',
  WEBHOOK_SECRET: 'abcdefghijklmnopqrstuvwxyz_123456',
  ADMIN_IDS: '111,222',
  YDB_CONNECTION_STRING: 'grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/db',
};

describe('loadConfig', () => {
  it('parses string Telegram IDs without precision loss', () => {
    expect(loadConfig(valid).adminIds).toEqual(new Set(['111', '222']));
  });

  it.each(['BOT_TOKEN', 'WEBHOOK_SECRET', 'ADMIN_IDS', 'YDB_CONNECTION_STRING'])(
    'rejects a missing %s',
    (key) => {
      const env = { ...valid };
      delete env[key as keyof typeof env];
      expect(() => loadConfig(env)).toThrow(`Missing ${key}`);
    },
  );

  it('rejects an invalid webhook secret', () => {
    expect(() => loadConfig({ ...valid, WEBHOOK_SECRET: 'spaces are forbidden' })).toThrow(
      'Invalid WEBHOOK_SECRET',
    );
  });
});
```

Run:

```powershell
npm.cmd test -- tests/config.test.ts
```

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Implement strict configuration parsing**

Create `src/config.ts` with this public API:

```ts
export interface AppConfig {
  botToken: string;
  webhookSecret: string;
  adminIds: ReadonlySet<string>;
  ydbConnectionString: string;
  timeZone: 'Europe/Moscow';
  maxActiveParticipants: 20;
}

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const webhookSecret = required(env, 'WEBHOOK_SECRET');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
    throw new Error('Invalid WEBHOOK_SECRET');
  }
  const adminIds = new Set(required(env, 'ADMIN_IDS').split(',').map((id) => id.trim()));
  if ([...adminIds].some((id) => !/^-?\d+$/.test(id))) throw new Error('Invalid ADMIN_IDS');
  return {
    botToken: required(env, 'BOT_TOKEN'),
    webhookSecret,
    adminIds,
    ydbConnectionString: required(env, 'YDB_CONNECTION_STRING'),
    timeZone: 'Europe/Moscow',
    maxActiveParticipants: 20,
  };
}
```

- [ ] **Step 4: Define shared domain types and injectable boundaries**

Create `src/domain/model.ts` with these exact unions and interfaces:

```ts
export type SessionStatus =
  | 'scheduled'
  | 'registration_open'
  | 'registration_closed'
  | 'playing'
  | 'finished';
export type ParticipantKind = 'player' | 'guest';
export type RosterStatus = 'active' | 'waitlist';
export type TeamRole = 'starter' | 'reserve';

export interface PlayerProfile {
  telegramUserId: string;
  displayName: string;
  username?: string;
}

export interface Session {
  sessionId: string;
  status: SessionStatus;
  nextQueuePosition: bigint;
  nextWinOrdinal: bigint;
  registrationMessageId?: string;
  scoreMessageId?: string;
}

export interface Participant {
  participantId: string;
  sessionId: string;
  ownerUserId: string;
  telegramUserId?: string;
  displayName: string;
  kind: ParticipantKind;
  guestNumber?: 1 | 2;
  queuePosition: bigint;
  rosterStatus: RosterStatus;
}

export interface Team {
  sessionId: string;
  teamNumber: 1 | 2 | 3 | 4;
}

export interface TeamMember extends Participant {
  teamNumber: Team['teamNumber'];
  role: TeamRole;
}

export interface WinEvent {
  sessionId: string;
  ordinal: bigint;
  teamNumber: Team['teamNumber'];
  adminUserId: string;
  createdAtIso: string;
  reversedAtIso?: string;
}

export interface WinAward {
  sessionId: string;
  winOrdinal: bigint;
  telegramUserId: string;
  displayName: string;
}
```

Create `src/ports/clock.ts` and `src/ports/random.ts`:

```ts
export interface Clock { now(): Date; }
export interface RandomSource { int(maxExclusive: number): number; }
```

Create `src/logger.ts` with `logInfo(event, fields)` and `logError(event, error, fields)` that emit one-line JSON and replace values for keys matching `/token|secret|authorization/i` with `[REDACTED]`.

Add `tests/logger.test.ts` to prove both top-level and nested sensitive fields are redacted while ordinary diagnostic fields remain usable:

```ts
import { describe, expect, it, vi } from 'vitest';
import { logInfo } from '../src/logger';

describe('structured logger', () => {
  it('recursively redacts secrets before writing one JSON line', () => {
    const write = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logInfo('deploy', {
      botToken: '123456:must-not-leak',
      nested: { authorization: 'Bearer must-not-leak', attempt: 2 },
    });
    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: 'deploy',
      botToken: '[REDACTED]',
      nested: { authorization: '[REDACTED]', attempt: 2 },
    });
    expect(line).not.toContain('must-not-leak');
  });
});
```

- [ ] **Step 5: Run the foundation checks**

Run:

```powershell
npm.cmd test -- tests/config.test.ts
npm.cmd test -- tests/logger.test.ts
npm.cmd run typecheck
```

Expected: tests PASS and TypeScript exits with code 0.

- [ ] **Step 6: Commit only foundation files**

```powershell
git add -- .nvmrc .gitignore package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts src/config.ts src/domain/model.ts src/ports/clock.ts src/ports/random.ts src/logger.ts tests/config.test.ts tests/logger.test.ts
git commit -m "build: establish typed serverless bot foundation"
```

---

### Task 2: Implement slot-level registration and FIFO waitlist promotion

**Files:**
- Create: `src/domain/registration.ts`
- Test: `tests/domain/registration.test.ts`

**Interfaces:**
- Consumes: `Participant`, `PlayerProfile`, `RosterStatus` from `src/domain/model.ts`.
- Produces: `changeParty(state, command)`, `rebalanceRoster(participants, maxActive)`, and `RegistrationChange`.

- [ ] **Step 1: Write the failing registration tests**

Create `tests/domain/registration.test.ts` with a deterministic ID factory and these cases:

```ts
import { describe, expect, it } from 'vitest';
import { changeParty } from '../../src/domain/registration';

const player = { telegramUserId: '111', displayName: 'Иван', username: 'ivan' };
const empty = { sessionId: '2026-07-24', participants: [], nextQueuePosition: 1n };

describe('changeParty', () => {
  it('creates the player and two separately queued guests', () => {
    const result = changeParty(empty, { player, partySize: 3 }, ['p1', 'g1', 'g2']);
    expect(result.participants.map((p) => [p.participantId, p.kind, p.queuePosition])).toEqual([
      ['p1', 'player', 1n], ['g1', 'guest', 2n], ['g2', 'guest', 3n],
    ]);
    expect(result.nextQueuePosition).toBe(4n);
  });

  it('keeps the player position and appends a newly added guest', () => {
    const one = changeParty(empty, { player, partySize: 1 }, ['p1']);
    const two = changeParty(one, { player, partySize: 2 }, ['g1']);
    expect(two.participants.map((p) => p.queuePosition)).toEqual([1n, 2n]);
  });

  it('removes the newest guest first and retains the player', () => {
    const three = changeParty(empty, { player, partySize: 3 }, ['p1', 'g1', 'g2']);
    const two = changeParty(three, { player, partySize: 2 }, []);
    expect(two.participants.map((p) => p.participantId)).toEqual(['p1', 'g1']);
  });

  it('places slots 21 and 22 in FIFO waitlist and promotes them after cancellation', () => {
    let state = empty;
    for (let i = 1; i <= 22; i += 1) {
      state = changeParty(
        state,
        { player: { telegramUserId: String(i), displayName: `P${i}` }, partySize: 1 },
        [`p${i}`],
      );
    }
    expect(state.participants.filter((p) => p.rosterStatus === 'active')).toHaveLength(20);
    expect(state.participants.find((p) => p.participantId === 'p21')?.rosterStatus).toBe('waitlist');
    state = changeParty(
      state,
      { player: { telegramUserId: '1', displayName: 'P1' }, partySize: 0 },
      [],
    );
    expect(state.participants.find((p) => p.participantId === 'p21')?.rosterStatus).toBe('active');
    expect(state.promotedOwnerIds).toEqual(['21']);
  });
});
```

Run:

```powershell
npm.cmd test -- tests/domain/registration.test.ts
```

Expected: FAIL because `src/domain/registration.ts` does not exist.

- [ ] **Step 2: Implement registration as a pure state transition**

Create `src/domain/registration.ts` with these exported types and rules:

```ts
import type { Participant, PlayerProfile } from './model';

export interface RegistrationState {
  sessionId: string;
  participants: Participant[];
  nextQueuePosition: bigint;
}
export interface RegistrationCommand { player: PlayerProfile; partySize: 0 | 1 | 2 | 3; }
export interface RegistrationChange extends RegistrationState { promotedOwnerIds: string[]; }

export function rebalanceRoster(participants: Participant[], maxActive = 20): Participant[] {
  return [...participants]
    .sort((a, b) => (a.queuePosition < b.queuePosition ? -1 : 1))
    .map((participant, index) => ({
      ...participant,
      rosterStatus: index < maxActive ? 'active' : 'waitlist',
    }));
}

export function changeParty(
  state: RegistrationState,
  command: RegistrationCommand,
  newParticipantIds: string[],
  maxActive = 20,
): RegistrationChange {
  if (!Number.isInteger(command.partySize) || command.partySize < 0 || command.partySize > 3) {
    throw new Error('partySize must be between 0 and 3');
  }
  const beforeWaitlist = new Set(
    state.participants.filter((p) => p.rosterStatus === 'waitlist').map((p) => p.participantId),
  );
  const owned = state.participants
    .filter((p) => p.ownerUserId === command.player.telegramUserId)
    .sort((a, b) => (a.queuePosition < b.queuePosition ? -1 : 1));
  const keep = owned.slice(0, command.partySize);
  const unrelated = state.participants.filter((p) => p.ownerUserId !== command.player.telegramUserId);
  let next = state.nextQueuePosition;
  let idIndex = 0;
  while (keep.length < command.partySize) {
    const participantId = newParticipantIds[idIndex++]!;
    if (keep.length === 0) {
      keep.push({
        participantId,
        sessionId: state.sessionId,
        ownerUserId: command.player.telegramUserId,
        telegramUserId: command.player.telegramUserId,
        displayName: command.player.displayName,
        kind: 'player',
        queuePosition: next++,
        rosterStatus: 'waitlist',
      });
    } else {
      const guestNumber = keep.length as 1 | 2;
      keep.push({
        participantId,
        sessionId: state.sessionId,
        ownerUserId: command.player.telegramUserId,
        displayName: `Гость ${guestNumber} — от ${command.player.displayName}`,
        kind: 'guest',
        guestNumber,
        queuePosition: next++,
        rosterStatus: 'waitlist',
      });
    }
  }
  const rebalanced = rebalanceRoster([...unrelated, ...keep], maxActive);
  const promotedOwnerIds = [...new Set(rebalanced
    .filter((p) => p.rosterStatus === 'active' && beforeWaitlist.has(p.participantId))
    .map((p) => p.ownerUserId))];
  return { sessionId: state.sessionId, participants: rebalanced, nextQueuePosition: next, promotedOwnerIds };
}
```

Update an existing player's display name in the retained player slot and refresh retained guest labels from the current `PlayerProfile.displayName`; never rewrite any retained participant's queue position.

- [ ] **Step 3: Add table-driven edge tests**

Extend the same test file with explicit cases for `+ → +1 → +2`, `+2 → +`, full cancellation, re-registration at the tail, a party split at positions 20–22, and `-2` clamping to the player-only application. Assert that queue positions are unique and strictly positive after every transition.

Run:

```powershell
npm.cmd test -- tests/domain/registration.test.ts
npm.cmd run typecheck
```

Expected: all registration tests PASS and typecheck exits with code 0.

- [ ] **Step 4: Commit registration domain files**

```powershell
git add -- src/domain/registration.ts tests/domain/registration.test.ts
git commit -m "feat: add FIFO football registration"
```

---

### Task 3: Form random complete teams and distribute team reserves evenly

**Files:**
- Create: `src/domain/teams.ts`
- Test: `tests/domain/teams.test.ts`

**Interfaces:**
- Consumes: active `Participant[]` and `RandomSource`.
- Produces: `formTeams(participants, random): TeamFormation` where `TeamFormation` contains persisted `teams` and `members`.

- [ ] **Step 1: Write failing deterministic team tests**

Create `tests/domain/teams.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formTeams } from '../../src/domain/teams';
import type { Participant } from '../../src/domain/model';

const participants = (count: number): Participant[] => Array.from({ length: count }, (_, i) => ({
  participantId: `p${i + 1}`,
  sessionId: '2026-07-24',
  ownerUserId: String(i + 1),
  telegramUserId: String(i + 1),
  displayName: `P${i + 1}`,
  kind: 'player',
  queuePosition: BigInt(i + 1),
  rosterStatus: 'active',
}));
const zeroRandom = { int: () => 0 };

describe('formTeams', () => {
  it.each([[0, 0], [9, 0], [10, 2], [14, 2], [15, 3], [18, 3], [19, 3], [20, 4]])(
    'forms %i participants into %i teams',
    (count, expectedTeams) => {
      expect(formTeams(participants(count), zeroRandom).teams).toHaveLength(expectedTeams);
    },
  );

  it('creates three starters of five and evenly distributes three reserves for 18', () => {
    const result = formTeams(participants(18), zeroRandom);
    for (const team of result.teams) {
      expect(result.members.filter((m) => m.teamNumber === team.teamNumber && m.role === 'starter')).toHaveLength(5);
      expect(result.members.filter((m) => m.teamNumber === team.teamNumber && m.role === 'reserve')).toHaveLength(1);
    }
    expect(new Set(result.members.map((m) => m.participantId)).size).toBe(18);
  });

  it('ignores waitlisted participants', () => {
    const list = participants(20);
    list.push({ ...participants(1)[0]!, participantId: 'wait', queuePosition: 21n, rosterStatus: 'waitlist' });
    expect(formTeams(list, zeroRandom).members.some((m) => m.participantId === 'wait')).toBe(false);
  });
});
```

Run:

```powershell
npm.cmd test -- tests/domain/teams.test.ts
```

Expected: FAIL because `src/domain/teams.ts` does not exist.

- [ ] **Step 2: Implement injected Fisher–Yates shuffle and assignment**

Create `src/domain/teams.ts`:

```ts
import type { Participant, Team, TeamMember } from './model';
import type { RandomSource } from '../ports/random';

export interface TeamFormation { teams: Team[]; members: TeamMember[]; }

export function shuffled<T>(values: readonly T[], random: RandomSource): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = random.int(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new Error('RandomSource returned an invalid index');
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export function formTeams(participants: readonly Participant[], random: RandomSource): TeamFormation {
  const active = shuffled(participants.filter((p) => p.rosterStatus === 'active'), random).slice(0, 20);
  const teamCount = Math.min(4, Math.floor(active.length / 5));
  if (teamCount < 2) return { teams: [], members: [] };
  const sessionId = active[0]!.sessionId;
  const teams = Array.from({ length: teamCount }, (_, i) => ({
    sessionId,
    teamNumber: (i + 1) as Team['teamNumber'],
  }));
  const members: TeamMember[] = [];
  for (let teamIndex = 0; teamIndex < teamCount; teamIndex += 1) {
    for (const participant of active.slice(teamIndex * 5, teamIndex * 5 + 5)) {
      members.push({ ...participant, teamNumber: teams[teamIndex]!.teamNumber, role: 'starter' });
    }
  }
  active.slice(teamCount * 5).forEach((participant, index) => {
    members.push({ ...participant, teamNumber: teams[index % teamCount]!.teamNumber, role: 'reserve' });
  });
  return { teams, members };
}
```

- [ ] **Step 3: Add invariant coverage and run checks**

Add a loop covering participant counts 0 through 25 and 50 deterministic random sequences. For each result assert: zero teams below 10 active; every team has exactly five starters; no member is duplicated; no waitlisted participant appears; all active participants up to 20 appear once; and reserve counts differ by at most one.

Run:

```powershell
npm.cmd test -- tests/domain/teams.test.ts
npm.cmd run typecheck
```

Expected: all team tests PASS and typecheck exits with code 0.

- [ ] **Step 4: Commit team formation**

```powershell
git add -- src/domain/teams.ts tests/domain/teams.test.ts
git commit -m "feat: form random football teams"
```

---

### Task 4: Model win events, safe undo, and competition ranking

**Files:**
- Create: `src/domain/scoring.ts`
- Test: `tests/domain/scoring.test.ts`

**Interfaces:**
- Consumes: `TeamMember[]`, `WinEvent[]`, `WinAward[]`, and completed session IDs.
- Produces: `awardsForWin`, `lastReversibleWin`, `dailyPlayerWins`, and `buildLeaderboard`.

- [ ] **Step 1: Write failing scoring tests**

Create `tests/domain/scoring.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { awardsForWin, buildLeaderboard, lastReversibleWin } from '../../src/domain/scoring';
import type { TeamMember, WinEvent, WinAward } from '../../src/domain/model';

const member = (id: string, role: 'starter' | 'reserve' = 'starter'): TeamMember => ({
  participantId: id,
  sessionId: '2026-07-24',
  ownerUserId: id,
  telegramUserId: id,
  displayName: `P${id}`,
  kind: 'player',
  queuePosition: BigInt(id),
  rosterStatus: 'active',
  teamNumber: 1,
  role,
});

describe('awardsForWin', () => {
  it('awards starters and team reserves but excludes guests', () => {
    const guest: TeamMember = {
      participantId: 'g', sessionId: '2026-07-24', ownerUserId: '9', displayName: 'Гость',
      kind: 'guest', guestNumber: 1, queuePosition: 9n, rosterStatus: 'active',
      teamNumber: 1, role: 'starter',
    };
    expect(awardsForWin('2026-07-24', 1n, [member('1'), member('2', 'reserve'), guest]))
      .toEqual([
        { sessionId: '2026-07-24', winOrdinal: 1n, telegramUserId: '1', displayName: 'P1' },
        { sessionId: '2026-07-24', winOrdinal: 1n, telegramUserId: '2', displayName: 'P2' },
      ]);
  });
});

describe('lastReversibleWin', () => {
  it('returns the greatest non-reversed ordinal', () => {
    const events: WinEvent[] = [
      { sessionId: 's', ordinal: 1n, teamNumber: 1, adminUserId: 'a', createdAtIso: '2026-01-01T00:00:00Z' },
      { sessionId: 's', ordinal: 2n, teamNumber: 2, adminUserId: 'a', createdAtIso: '2026-01-01T00:01:00Z', reversedAtIso: '2026-01-01T00:02:00Z' },
      { sessionId: 's', ordinal: 3n, teamNumber: 1, adminUserId: 'a', createdAtIso: '2026-01-01T00:03:00Z' },
    ];
    expect(lastReversibleWin(events)?.ordinal).toBe(3n);
  });
});

describe('buildLeaderboard', () => {
  it('counts only active awards from completed sessions and ranks 1, 1, 3', () => {
    const events: WinEvent[] = [
      { sessionId: 'done', ordinal: 1n, teamNumber: 1, adminUserId: 'a', createdAtIso: 'x' },
      { sessionId: 'done', ordinal: 2n, teamNumber: 1, adminUserId: 'a', createdAtIso: 'x' },
      { sessionId: 'open', ordinal: 1n, teamNumber: 1, adminUserId: 'a', createdAtIso: 'x' },
    ];
    const awards: WinAward[] = [
      { sessionId: 'done', winOrdinal: 1n, telegramUserId: '1', displayName: 'Антон' },
      { sessionId: 'done', winOrdinal: 1n, telegramUserId: '2', displayName: 'Борис' },
      { sessionId: 'done', winOrdinal: 1n, telegramUserId: '3', displayName: 'Виктор' },
      { sessionId: 'done', winOrdinal: 2n, telegramUserId: '1', displayName: 'Антон' },
      { sessionId: 'done', winOrdinal: 2n, telegramUserId: '2', displayName: 'Борис' },
      { sessionId: 'open', winOrdinal: 1n, telegramUserId: '1', displayName: 'Антон' },
    ];
    expect(buildLeaderboard(events, awards, new Set(['done']), new Map())).toEqual([
      { rank: 1, telegramUserId: '1', displayName: 'Антон', wins: 2 },
      { rank: 1, telegramUserId: '2', displayName: 'Борис', wins: 2 },
      { rank: 3, telegramUserId: '3', displayName: 'Виктор', wins: 1 },
    ]);
  });
});
```

Use object construction that omits `telegramUserId` for the guest instead of assigning `undefined` when implementing under `exactOptionalPropertyTypes`.

Run:

```powershell
npm.cmd test -- tests/domain/scoring.test.ts
```

Expected: FAIL because `src/domain/scoring.ts` does not exist.

- [ ] **Step 2: Implement scoring selectors**

Create `src/domain/scoring.ts` with these signatures:

```ts
import type { TeamMember, WinAward, WinEvent } from './model';

export interface LeaderboardRow {
  rank: number;
  telegramUserId: string;
  displayName: string;
  wins: number;
}

export function awardsForWin(
  sessionId: string,
  winOrdinal: bigint,
  members: readonly TeamMember[],
): WinAward[] {
  return members.flatMap((member) => member.telegramUserId ? [{
    sessionId,
    winOrdinal,
    telegramUserId: member.telegramUserId,
    displayName: member.displayName,
  }] : []);
}

export function lastReversibleWin(events: readonly WinEvent[]): WinEvent | undefined {
  return events.filter((event) => !event.reversedAtIso)
    .sort((a, b) => (a.ordinal > b.ordinal ? -1 : 1))[0];
}

export function buildLeaderboard(
  events: readonly WinEvent[],
  awards: readonly WinAward[],
  completedSessionIds: ReadonlySet<string>,
  currentDisplayNames: ReadonlyMap<string, string>,
): LeaderboardRow[] {
  const active = new Set(events
    .filter((event) => completedSessionIds.has(event.sessionId) && !event.reversedAtIso)
    .map((event) => `${event.sessionId}:${event.ordinal}`));
  const rows = new Map<string, { displayName: string; wins: number }>();
  for (const award of awards) {
    if (!active.has(`${award.sessionId}:${award.winOrdinal}`)) continue;
    const displayName = currentDisplayNames.get(award.telegramUserId) ?? award.displayName;
    const current = rows.get(award.telegramUserId) ?? { displayName, wins: 0 };
    rows.set(award.telegramUserId, { displayName, wins: current.wins + 1 });
  }
  const sorted = [...rows].map(([telegramUserId, value]) => ({ telegramUserId, ...value }))
    .sort((a, b) => b.wins - a.wins || a.displayName.localeCompare(b.displayName, 'ru'));
  const ranked: LeaderboardRow[] = [];
  for (const [index, row] of sorted.entries()) {
    const previous = ranked[index - 1];
    ranked.push({
      ...row,
      rank: previous && previous.wins === row.wins ? previous.rank : index + 1,
    });
  }
  return ranked;
}
```

- [ ] **Step 3: Cover reversed wins and daily aggregation**

Add `dailyPlayerWins(sessionId, events, awards)` and tests proving that a reversed win contributes zero, an active win contributes one per award, two wins of one team contribute two, a current player profile overrides an old award display name, and a duplicate award row with the same `(sessionId, winOrdinal, telegramUserId)` is rejected by the store contract rather than double-counted.

Run:

```powershell
npm.cmd test -- tests/domain/scoring.test.ts
npm.cmd run typecheck
```

Expected: scoring tests PASS and typecheck exits with code 0.

- [ ] **Step 4: Commit scoring**

```powershell
git add -- src/domain/scoring.ts tests/domain/scoring.test.ts
git commit -m "feat: add auditable personal win ranking"
```

---

### Task 5: Reconcile the Moscow weekly schedule idempotently

**Files:**
- Create: `src/domain/schedule.ts`
- Test: `tests/domain/schedule.test.ts`

**Interfaces:**
- Consumes: UTC `Date`, existing `SessionStatus`, and completed action keys.
- Produces: `sessionIdForCurrentCycle(now)`, `dueScheduleActions(input)`, `nextScheduleAction(now, status)`, and stable `ScheduleAction` keys.

- [ ] **Step 1: Write failing boundary tests**

Create `tests/domain/schedule.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dueScheduleActions, sessionIdForCurrentCycle } from '../../src/domain/schedule';

const due = (iso: string, completed: string[] = [], status?: string) => dueScheduleActions({
  now: new Date(iso),
  completedActionKeys: new Set(completed),
  sessionStatus: status as never,
});

describe('Moscow schedule', () => {
  it('opens Tuesday at 10:00 Moscow, which is 07:00 UTC', () => {
    expect(due('2026-07-21T06:59:59Z')).toEqual([]);
    expect(due('2026-07-21T07:00:00Z').map((a) => a.kind)).toEqual(['open']);
    expect(sessionIdForCurrentCycle(new Date('2026-07-21T07:00:00Z'))).toBe('2026-07-24');
  });

  it.each([
    ['2026-07-22T07:00:00Z', 'wed'],
    ['2026-07-23T07:00:00Z', 'thu'],
    ['2026-07-24T07:00:00Z', 'fri'],
  ])('emits the %s current-day reminder once', (iso, day) => {
    const action = due(iso, [], 'registration_open').find((item) => item.kind === 'reminder');
    expect(action?.key).toBe(`2026-07-24:reminder:${day}`);
    expect(due(iso, [action!.key], 'registration_open')).toEqual([]);
  });

  it('closes Friday at 20:55 Moscow and catches up later', () => {
    expect(due('2026-07-24T17:54:59Z', [], 'registration_open')).toEqual([]);
    expect(due('2026-07-24T17:55:00Z', [], 'registration_open').map((a) => a.kind)).toEqual(['close']);
    expect(due('2026-07-24T18:20:00Z', [], 'registration_open').map((a) => a.kind)).toEqual(['close']);
  });

  it('does not backfill Wednesday reminder on Thursday', () => {
    const actions = due('2026-07-23T08:00:00Z', [], 'registration_open');
    expect(actions.filter((a) => a.kind === 'reminder').map((a) => a.key)).toEqual([
      '2026-07-24:reminder:thu',
    ]);
  });
});
```

Run:

```powershell
npm.cmd test -- tests/domain/schedule.test.ts
```

Expected: FAIL because `src/domain/schedule.ts` does not exist.

- [ ] **Step 2: Implement schedule calculation with Luxon**

Create `src/domain/schedule.ts` around the exact public contract:

```ts
import { DateTime } from 'luxon';
import type { SessionStatus } from './model';

export type ScheduleActionKind = 'open' | 'reminder' | 'close';
export interface ScheduleAction { key: string; sessionId: string; kind: ScheduleActionKind; }
export interface ScheduleInput {
  now: Date;
  completedActionKeys: ReadonlySet<string>;
  sessionStatus?: SessionStatus;
}

const ZONE = 'Europe/Moscow';

export function sessionIdForCurrentCycle(now: Date): string {
  const local = DateTime.fromJSDate(now, { zone: ZONE });
  const daysUntilFriday = (5 - local.weekday + 7) % 7;
  return local.plus({ days: daysUntilFriday }).toISODate()!;
}
```

Implement `dueScheduleActions` so it only emits `open` between Tuesday 10:00 and Friday 20:55 when a current session is absent/scheduled; emits only today's due reminder while registration is open; and emits `close` from Friday 20:55 onward while registration is open. Filter every result by `completedActionKeys`. On Saturday through Monday, target the next Friday and emit no action.

- [ ] **Step 3: Add timezone and duplicate-action coverage**

Add tests for Monday 23:59, Tuesday catch-up at 12:00, Friday at exactly 10:00 and 20:55, Saturday, an already completed open key, a finished session, and two invocations in the same minute returning the same stable key.

Add `nextScheduleAction(now, status)` tests showing the next Moscow action and ISO instant for `/status`: Tuesday open, the next daily reminder while open, Friday close while open, and next Tuesday open after finish.

Run:

```powershell
npm.cmd test -- tests/domain/schedule.test.ts
npm.cmd run typecheck
```

Expected: schedule tests PASS and typecheck exits with code 0.

- [ ] **Step 4: Commit schedule logic**

```powershell
git add -- src/domain/schedule.ts tests/domain/schedule.test.ts
git commit -m "feat: reconcile Moscow football schedule"
```

---

### Task 6: Build the safe Telegram client and branded message renderer

**Files:**
- Create: `src/application/views.ts`
- Create: `src/adapters/telegram/types.ts`
- Create: `src/adapters/telegram/client.ts`
- Create: `src/adapters/telegram/render.ts`
- Create: `src/ports/telegram.ts`
- Test: `tests/telegram/client.test.ts`
- Test: `tests/telegram/render.test.ts`

**Interfaces:**
- Produces: immutable presentation snapshots, supported Telegram `Update` subset, `TelegramPort`, `TelegramClient`, `escapeHtml`, and render functions for registration, teams, score panel, daily results, leaderboard, and status.
- Consumes: domain snapshots only; renderers do not query YDB.

- [ ] **Step 1: Write failing renderer tests**

Create `tests/telegram/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderRegistrationCard, registrationKeyboard } from '../../src/adapters/telegram/render';

describe('Telegram rendering', () => {
  it('escapes all Telegram HTML metacharacters', () => {
    expect(escapeHtml('<Иван & "Ко">')).toBe('&lt;Иван &amp; &quot;Ко&quot;&gt;');
  });

  it('shows venue, time, progress, active list, and waitlist', () => {
    const text = renderRegistrationCard({
      sessionId: '2026-07-24',
      active: [{ displayName: '<Иван>' }],
      waitlist: [{ displayName: 'Пётр' }],
      maxActive: 20,
    });
    expect(text).toContain('Манеж «Пингвин»');
    expect(text).toContain('21:00');
    expect(text).toContain('1 из 20');
    expect(text).toContain('&lt;Иван&gt;');
    expect(text).toContain('Общий резерв');
  });

  it('uses versioned compact callback data', () => {
    expect(registrationKeyboard()).toEqual({ inline_keyboard: [
      [{ text: '✅ Иду один', callback_data: 'v1:r:1' }, { text: '👥 Я +1', callback_data: 'v1:r:2' }],
      [{ text: '👥 Я +2', callback_data: 'v1:r:3' }, { text: '❌ Отменить', callback_data: 'v1:r:0' }],
      [{ text: '📋 Состав', callback_data: 'v1:r:list' }],
    ] });
  });
});
```

Run:

```powershell
npm.cmd test -- tests/telegram/render.test.ts
```

Expected: FAIL because renderer files do not exist.

- [ ] **Step 2: Define presentation snapshots, the Telegram port, and supported update types**

Create `src/application/views.ts`; this is the only shape the render layer consumes:

```ts
import type { SessionStatus, Team } from '../domain/model';

export interface NamedParticipantView { displayName: string; }
export interface RegistrationView {
  sessionId: string;
  active: readonly NamedParticipantView[];
  waitlist: readonly NamedParticipantView[];
  maxActive: 20;
}
export interface TeamView {
  teamNumber: Team['teamNumber'];
  starters: readonly NamedParticipantView[];
  reserves: readonly NamedParticipantView[];
}
export interface TeamsView { sessionId: string; teams: readonly TeamView[]; }
export interface ScoreView {
  sessionId: string;
  teams: readonly { teamNumber: Team['teamNumber']; wins: number }[];
  finished: boolean;
}
export interface DailyResultsView {
  sessionId: string;
  teams: readonly { teamNumber: Team['teamNumber']; wins: number }[];
  rows: readonly { displayName: string; wins: number }[];
}
export interface StatusView {
  sessionId: string;
  sessionStatus: SessionStatus;
  nextActionKind: 'open' | 'reminder' | 'close';
  nextActionAtIso: string;
  activeCount: number;
  waitlistCount: number;
  teamCount: number;
  pendingEffectCount: number;
  lastSafeError?: string;
}
```

Create `src/ports/telegram.ts`:

```ts
export interface InlineKeyboard { inline_keyboard: Array<Array<{ text: string; callback_data: string }>>; }
export interface SentMessage { messageId: string; }
export interface TelegramPort {
  sendMessage(chatId: string, html: string, keyboard?: InlineKeyboard): Promise<SentMessage>;
  editMessage(chatId: string, messageId: string, html: string, keyboard?: InlineKeyboard): Promise<void>;
  answerCallback(callbackQueryId: string, text: string, showAlert?: boolean): Promise<void>;
  pinMessage(chatId: string, messageId: string): Promise<void>;
}
```

Create `src/adapters/telegram/types.ts` with only the Bot API fields used by the app: `Update.update_id`, group `Message`, `User`, `Chat`, `CallbackQuery`, `MessageEntity`, and API response `{ ok, result, description?, parameters?: { retry_after?: number } }`. Keep Telegram IDs as JSON numbers only during parsing, then immediately convert with `String(value)`; reject non-safe integer IDs rather than silently rounding.

- [ ] **Step 3: Implement renderers and keyboard contracts**

Create `src/adapters/telegram/render.ts` with `escapeHtml` replacing `&`, `<`, `>`, `"`, and `'`; a ten-block progress bar; Russian date formatting; fixed team colors; and these exported functions:

```ts
export function renderRegistrationCard(view: RegistrationView): string;
export function registrationKeyboard(): InlineKeyboard;
export function renderTeams(view: TeamsView): string;
export function renderReminder(view: RegistrationView): string;
export function renderPromotion(displayName: string): string;
export function renderScorePanel(view: ScoreView): string;
export function scoreKeyboard(teamNumbers: readonly (1 | 2 | 3 | 4)[]): InlineKeyboard;
export function renderDailyResults(view: DailyResultsView): string;
export function renderLeaderboard(rows: readonly LeaderboardRow[]): string;
export function renderStatus(view: StatusView): string;
```

Use callback data exactly: `v1:r:0..3`, `v1:r:list`, `v1:w:1..4`, `v1:w:undo`, `v1:w:finish`, and `v1:w:confirm_finish`. Keep every callback string below Telegram's 64-byte limit.

- [ ] **Step 4: Write failing Telegram HTTP retry tests**

Create `tests/telegram/client.test.ts` using injected `fetch` and `sleep` functions. Cover: `sendMessage` uses POST JSON and `parse_mode: HTML`; a `429` sleeps exactly `retry_after × 1000`; a `500` retries with 250 ms then 500 ms; a `400` throws without retry; returned numeric `message_id` becomes a string; and error messages never contain the bot token.

Representative test:

```ts
it('honors Telegram retry_after', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 2 } }), { status: 429 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }));
  const sleep = vi.fn().mockResolvedValue(undefined);
  const client = new TelegramClient('secret-token', fetcher, sleep);
  await expect(client.sendMessage('-100', 'text')).resolves.toEqual({ messageId: '7' });
  expect(sleep).toHaveBeenCalledWith(2000);
});
```

- [ ] **Step 5: Implement the Bot API client**

Create `src/adapters/telegram/client.ts` implementing `TelegramPort`. Centralize all methods through:

```ts
private async call<T>(method: string, body: Record<string, unknown>): Promise<T>
```

Use `AbortSignal.timeout(8_000)`, at most three attempts, Telegram `retry_after` for `429`, delays `[250, 500]` for transient `5xx`/network errors, and no retry for other `4xx`. Throw `TelegramApiError` containing method, status, and Telegram description but never the request URL or token.

- [ ] **Step 6: Run Telegram tests and commit**

Run:

```powershell
npm.cmd test -- tests/telegram
npm.cmd run typecheck
```

Expected: all Telegram tests PASS and typecheck exits with code 0.

Commit:

```powershell
git add -- src/application/views.ts src/adapters/telegram src/ports/telegram.ts tests/telegram
git commit -m "feat: add safe Telegram presentation layer"
```

---

### Task 7: Add transactional application services with an in-memory contract test store

**Files:**
- Create: `src/ports/store.ts`
- Create: `src/application/bot-service.ts`
- Create: `src/application/scheduler.ts`
- Create: `tests/support/in-memory-store.ts`
- Create: `tests/support/fake-telegram.ts`
- Test: `tests/application/bot-service.test.ts`
- Test: `tests/application/scheduler.test.ts`

**Interfaces:**
- Consumes: all pure domain functions, `Clock`, `RandomSource`, `TelegramPort`.
- Produces: `FootballStore`, `FootballTransaction`, `BotService`, `Scheduler`, and serializable `TelegramEffect` values for the outbox.

- [ ] **Step 1: Define the storage transaction contract**

Create `src/ports/store.ts` with exact records and methods:

```ts
import type { Participant, PlayerProfile, Session, Team, TeamMember, WinAward, WinEvent } from '../domain/model';

export type TelegramEffect =
  | { kind: 'registration_card'; sessionId: string }
  | { kind: 'promotion_notice'; sessionId: string; ownerUserId: string }
  | { kind: 'reminder'; sessionId: string; actionKey: string }
  | { kind: 'teams'; sessionId: string }
  | { kind: 'score_panel'; sessionId: string }
  | { kind: 'final_results'; sessionId: string }
  | { kind: 'admin_error'; correlationId: string; summary: string };

export interface StoredEffect {
  effectId: string;
  effect: TelegramEffect;
  attempts: number;
  nextAttemptAtIso: string;
}

export interface BotSettings { groupChatId?: string; }
export interface OperationalStatus { pendingEffectCount: number; lastSafeError?: string; }

export interface FootballTransaction {
  getSettings(): Promise<BotSettings>;
  saveSettings(settings: BotSettings): Promise<void>;
  upsertPlayer(player: PlayerProfile, nowIso: string): Promise<void>;
  listPlayers(): Promise<PlayerProfile[]>;
  getSession(sessionId: string): Promise<Session | undefined>;
  saveSession(session: Session): Promise<void>;
  listParticipants(sessionId: string): Promise<Participant[]>;
  replaceParticipants(sessionId: string, participants: readonly Participant[]): Promise<void>;
  listTeams(sessionId: string): Promise<Team[]>;
  listTeamMembers(sessionId: string): Promise<TeamMember[]>;
  replaceTeams(sessionId: string, teams: readonly Team[], members: readonly TeamMember[]): Promise<void>;
  listWinEvents(sessionId?: string): Promise<WinEvent[]>;
  listWinAwards(sessionId?: string): Promise<WinAward[]>;
  appendWin(event: WinEvent, awards: readonly WinAward[]): Promise<void>;
  reverseWin(sessionId: string, ordinal: bigint, reversedAtIso: string): Promise<void>;
  listCompletedSessionIds(): Promise<Set<string>>;
  hasScheduledAction(actionKey: string): Promise<boolean>;
  markScheduledAction(actionKey: string, sessionId: string, kind: string, executedAtIso: string): Promise<void>;
  enqueue(effectId: string, effect: TelegramEffect, nowIso: string): Promise<void>;
}

export interface UpdateExecution<T> { duplicate: boolean; value?: T; }
export interface FootballStore {
  transact<T>(work: (tx: FootballTransaction) => Promise<T>): Promise<T>;
  transactUpdate<T>(updateId: string, nowIso: string, work: (tx: FootballTransaction) => Promise<T>): Promise<UpdateExecution<T>>;
  claimDueEffects(nowIso: string, limit: number, leaseId: string): Promise<StoredEffect[]>;
  markEffectSent(effectId: string, sentAtIso: string): Promise<void>;
  rescheduleEffect(effectId: string, attempts: number, nextAttemptAtIso: string, safeError: string): Promise<void>;
  markEffectPermanentlyFailed(effectId: string, failedAtIso: string, safeError: string): Promise<void>;
  getOperationalStatus(): Promise<OperationalStatus>;
}
```

`transactUpdate` must insert `processed_updates` in the same serializable transaction as the business change. A duplicate returns `{ duplicate: true }` without calling `work`.

- [ ] **Step 2: Create the in-memory store and fake Telegram port**

Create `tests/support/in-memory-store.ts` implementing every method above with cloned maps and a serialized promise queue. On transaction failure, discard the clone. Enforce uniqueness of `(sessionId, ordinal)` win events and `(sessionId, winOrdinal, telegramUserId)` awards. Implement effect leasing by excluding sent/permanently-failed effects, effects whose `nextAttemptAtIso` is in the future, and active leases; an expired lease must become claimable again.

Create `tests/support/fake-telegram.ts` implementing `TelegramPort` and recording typed calls in `calls`. Return monotonically increasing message IDs from `sendMessage`.

- [ ] **Step 3: Write failing application use-case tests**

Create `tests/application/bot-service.test.ts` with a fixed clock, deterministic IDs, and random source. Include this core flow plus separate tests for each rejection:

```ts
it('runs registration, close, wins, undo, and finish exactly once', async () => {
  const app = fixture();
  await app.service.setup('u:setup', '900', '-1001');
  await app.service.openNow('u:open', '900');
  for (let i = 1; i <= 10; i += 1) {
    await app.service.setParty(`u:r:${i}`, { telegramUserId: String(i), displayName: `P${i}` }, 1);
  }
  const closed = await app.service.closeNow('u:close', '900');
  expect(closed.teamCount).toBe(2);
  const first = await app.service.recordWin('u:w:1', '900', 1);
  expect(first.duplicate).toBe(false);
  expect((await app.service.recordWin('u:w:1', '900', 1)).duplicate).toBe(true);
  await app.service.undoLastWin('u:undo', '900');
  const finished = await app.service.finish('u:finish', '900');
  expect(finished.leaderboard).toEqual([]);
});
```

Add explicit tests that:

- non-admin setup, close, win, undo, and finish throw `ForbiddenError`;
- registration before opening or after closing throws `InvalidStateError`;
- 21st slot is waitlisted and promoted after the first cancellation;
- closing with 9 people publishes one `Недостаточно для двух команд` teams/result message, creates no score panel, and leaves status `registration_closed`;
- closing with 10 people persists two teams and changes status to `playing`;
- a win for an unknown team is rejected;
- all player members and team reserves receive awards while guests do not;
- undo reverses only the highest active ordinal;
- finish is idempotent and locks further wins;
- the final leaderboard includes only completed sessions.
- `/status` data includes the current phase, active/waitlist/team counts, next Moscow action, pending effect count, and last safe error without secret values.

Run:

```powershell
npm.cmd test -- tests/application/bot-service.test.ts
```

Expected: FAIL because `BotService` does not exist.

- [ ] **Step 4: Implement BotService through store transactions**

Create `src/application/bot-service.ts` with this constructor and public API:

```ts
export class BotService {
  constructor(
    private readonly store: FootballStore,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly adminIds: ReadonlySet<string>,
    private readonly newId: () => string,
  ) {}

  setup(updateId: string, actorUserId: string, chatId: string): Promise<UpdateExecution<void>>;
  openNow(updateId: string, actorUserId: string): Promise<UpdateExecution<{ sessionId: string }>>;
  setParty(updateId: string, player: PlayerProfile, partySize: 0 | 1 | 2 | 3): Promise<UpdateExecution<RegistrationChange>>;
  closeNow(updateId: string, actorUserId: string): Promise<UpdateExecution<{ sessionId: string; teamCount: number }>>;
  recordWin(updateId: string, actorUserId: string, teamNumber: 1 | 2 | 3 | 4): Promise<UpdateExecution<{ ordinal: bigint }>>;
  undoLastWin(updateId: string, actorUserId: string): Promise<UpdateExecution<{ reversedOrdinal?: bigint }>>;
  finish(updateId: string, actorUserId: string): Promise<UpdateExecution<{ leaderboard: LeaderboardRow[] }>>;
  getPartySize(telegramUserId: string): Promise<0 | 1 | 2 | 3>;
  registrationView(): Promise<RegistrationView>;
  status(): Promise<StatusView>;
}
```

Use the `RegistrationView` and `StatusView` contracts from `src/application/views.ts`. Build status from a snapshot transaction, `nextScheduleAction`, and `store.getOperationalStatus()`.

Use `sessionIdForCurrentCycle(clock.now())`. Every mutating method calls `transactUpdate`. `setParty` persists the player profile, loads participants, calls `changeParty`, saves the replacement, and enqueues one registration-card effect plus one promotion effect per promoted owner. `closeNow` changes state, always enqueues a `teams` effect (the zero-team renderer explains that 10 players were not reached), and enqueues `score_panel` only when at least two teams exist. `recordWin` increments `nextWinOrdinal` in the saved session and stores event plus awards atomically. `finish` stores `finished`, loads current player profiles for display names, computes the completed-session leaderboard, and enqueues one final-results effect.

Define and export `ForbiddenError`, `InvalidStateError`, and `NotFoundError`; the router will convert them to Russian callback alerts.

- [ ] **Step 5: Write scheduler transaction tests**

Create `tests/application/scheduler.test.ts` proving that two ticks at the same instant create one scheduled-action row and one effect; a Tuesday catch-up opens a session; Thursday does not enqueue Wednesday's reminder; Friday close catches up after 20:55; and a failed transaction leaves neither the action key nor an outbox row.

Representative assertion:

```ts
await Promise.all([scheduler.tick(), scheduler.tick()]);
expect(store.scheduledActionKeys()).toEqual(['2026-07-24:open']);
expect(store.pendingEffects().filter((e) => e.effect.kind === 'registration_card')).toHaveLength(1);
```

- [ ] **Step 6: Implement Scheduler using the same domain operations**

Create `src/application/scheduler.ts` with `tick(): Promise<void>`. In one `store.transact` call, load the current session and schedule keys, call `dueScheduleActions`, and for each action:

- `open`: create/save `registration_open` session and enqueue `registration_card`;
- `reminder`: enqueue `reminder` only while open;
- `close`: call the same internal close operation used by `BotService.closeNow`, always enqueue `teams` (including the insufficient-player explanation), and enqueue `score_panel` only when at least two teams exist;
- mark the action key only after all state and outbox writes have succeeded in the same transaction.

Do not call Telegram from inside the YDB transaction.

- [ ] **Step 7: Run application tests and commit**

Run:

```powershell
npm.cmd test -- tests/application
npm.cmd run typecheck
```

Expected: all application tests PASS and typecheck exits with code 0.

Commit:

```powershell
git add -- src/ports/store.ts src/application/bot-service.ts src/application/scheduler.ts tests/support/in-memory-store.ts tests/support/fake-telegram.ts tests/application
git commit -m "feat: orchestrate transactional football sessions"
```

---

### Task 8: Persist all state in YDB with serializable retries and migrations

**Files:**
- Create: `migrations/001_initial.sql`
- Create: `src/adapters/ydb/connection.ts`
- Create: `src/adapters/ydb/migrate.ts`
- Create: `src/adapters/ydb/store.ts`
- Create: `tests/integration/ydb-store.test.ts`

**Interfaces:**
- Implements: every `FootballStore` and `FootballTransaction` method from Task 7.
- Produces: `getYdbDriver(connectionString)` and `YdbFootballStore`.

- [ ] **Step 1: Write the complete idempotent YDB schema**

Create `migrations/001_initial.sql` with `-- statement-break` between these complete `CREATE TABLE IF NOT EXISTS` statements:

```sql
CREATE TABLE IF NOT EXISTS settings (
  key Utf8 NOT NULL,
  value Utf8 NOT NULL,
  updated_at Timestamp NOT NULL,
  PRIMARY KEY (key)
);
-- statement-break
CREATE TABLE IF NOT EXISTS players (
  telegram_user_id Utf8 NOT NULL,
  display_name Utf8 NOT NULL,
  username Utf8,
  updated_at Timestamp NOT NULL,
  PRIMARY KEY (telegram_user_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS sessions (
  session_id Utf8 NOT NULL,
  status Utf8 NOT NULL,
  next_queue_position Uint64 NOT NULL,
  next_win_ordinal Uint64 NOT NULL,
  registration_message_id Utf8,
  score_message_id Utf8,
  created_at Timestamp NOT NULL,
  closed_at Timestamp,
  finished_at Timestamp,
  PRIMARY KEY (session_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS participants (
  session_id Utf8 NOT NULL,
  participant_id Utf8 NOT NULL,
  owner_user_id Utf8 NOT NULL,
  telegram_user_id Utf8,
  display_name Utf8 NOT NULL,
  kind Utf8 NOT NULL,
  guest_number Uint8,
  queue_position Uint64 NOT NULL,
  roster_status Utf8 NOT NULL,
  PRIMARY KEY (session_id, participant_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS teams (
  session_id Utf8 NOT NULL,
  team_number Uint8 NOT NULL,
  PRIMARY KEY (session_id, team_number)
);
-- statement-break
CREATE TABLE IF NOT EXISTS team_members (
  session_id Utf8 NOT NULL,
  team_number Uint8 NOT NULL,
  participant_id Utf8 NOT NULL,
  role Utf8 NOT NULL,
  PRIMARY KEY (session_id, team_number, participant_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS win_events (
  session_id Utf8 NOT NULL,
  ordinal Uint64 NOT NULL,
  team_number Uint8 NOT NULL,
  admin_user_id Utf8 NOT NULL,
  created_at Timestamp NOT NULL,
  reversed_at Timestamp,
  PRIMARY KEY (session_id, ordinal)
);
-- statement-break
CREATE TABLE IF NOT EXISTS win_awards (
  session_id Utf8 NOT NULL,
  win_ordinal Uint64 NOT NULL,
  telegram_user_id Utf8 NOT NULL,
  display_name Utf8 NOT NULL,
  PRIMARY KEY (session_id, win_ordinal, telegram_user_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id Utf8 NOT NULL,
  processed_at Timestamp NOT NULL,
  PRIMARY KEY (update_id)
) WITH (TTL = Interval("P90D") ON processed_at);
-- statement-break
CREATE TABLE IF NOT EXISTS scheduled_actions (
  action_key Utf8 NOT NULL,
  session_id Utf8 NOT NULL,
  kind Utf8 NOT NULL,
  executed_at Timestamp NOT NULL,
  PRIMARY KEY (action_key)
);
-- statement-break
CREATE TABLE IF NOT EXISTS outbox (
  effect_id Utf8 NOT NULL,
  kind Utf8 NOT NULL,
  payload_json Utf8 NOT NULL,
  status Utf8 NOT NULL,
  attempts Uint32 NOT NULL,
  next_attempt_at Timestamp NOT NULL,
  lease_id Utf8,
  lease_until Timestamp,
  created_at Timestamp NOT NULL,
  sent_at Timestamp,
  failed_at Timestamp,
  last_error Utf8,
  PRIMARY KEY (effect_id)
);
-- statement-break
CREATE TABLE IF NOT EXISTS schema_migrations (
  version Uint32 NOT NULL,
  applied_at Timestamp NOT NULL,
  PRIMARY KEY (version)
);
```

- [ ] **Step 2: Implement a cached metadata-authenticated driver**

Create `src/adapters/ydb/connection.ts` using environment-selected credentials so production uses metadata and local migrations use a short-lived IAM token:

```ts
import { EnvironCredentialsProvider } from '@ydbjs/auth/environ';
import { Driver } from '@ydbjs/core';

let cached: Promise<Driver> | undefined;

export function getYdbDriver(connectionString: string): Promise<Driver> {
  cached ??= (async () => {
    const credentials = new EnvironCredentialsProvider(connectionString);
    const driver = new Driver(connectionString, {
      credentialsProvider: credentials,
      secureOptions: credentials.secureOptions,
    });
    await driver.ready({ timeoutMs: 8_000 });
    return driver;
  })().catch((error) => { cached = undefined; throw error; });
  return cached;
}
```

Check the installed SDK type for `ready`; if it accepts a number rather than `{ timeoutMs }`, use `await driver.ready(8_000)`. Do not invent a wrapper cast or disable TypeScript.

- [ ] **Step 3: Implement the migration runner**

Create `src/adapters/ydb/migrate.ts` to read `migrations/001_initial.sql`, split on the exact marker, and execute trusted DDL through `sql`${sql.unsafe(statement)}``. Apply each migration outside a DML transaction, then `UPSERT` version 1 into `schema_migrations`. Running the command twice must succeed without changing application rows.

Run against local YDB when `YDB_ANONYMOUS_CREDENTIALS=1`; use `YDB_ACCESS_TOKEN_CREDENTIALS` for workstation-to-cloud migrations and `YDB_METADATA_CREDENTIALS=1` in Cloud Function. Never accept a migration path or SQL string from Telegram/user input.

- [ ] **Step 4: Write failing YDB adapter contract tests**

Create `tests/integration/ydb-store.test.ts`. Read `YDB_TEST_CONNECTION_STRING`; skip only when it is absent. Against a dedicated disposable local/test database (the migration uses fixed production table names, not a table-name prefix), run migrations twice and execute the same behavioral contract as the in-memory store:

```ts
it('deduplicates update and business writes in one transaction', async () => {
  const first = await store.transactUpdate('42', now, async (tx) => {
    await tx.saveSettings({ groupChatId: '-100' });
    return 'saved';
  });
  const second = await store.transactUpdate('42', now, async () => 'must-not-run');
  expect(first).toEqual({ duplicate: false, value: 'saved' });
  expect(second).toEqual({ duplicate: true });
  expect(await store.transact((tx) => tx.getSettings())).toEqual({ groupChatId: '-100' });
});
```

Also test rollback, participant replacement, team replacement, unique award enforcement, reverse win, completed-session selection, schedule key uniqueness, and outbox lease/reschedule/sent/permanently-failed transitions.

- [ ] **Step 5: Implement YdbFootballStore**

Create `src/adapters/ydb/store.ts`. Use `query(driver).begin({ isolation: 'serializableReadWrite', idempotent: true }, callback)` for every mutation. Bind all values through template interpolation; the only `unsafe` SQL is fixed migration text. Convert YDB `Uint64` values to `bigint`, optional values to omitted TypeScript properties, and `Timestamp` values to ISO strings at the adapter boundary.

For `replaceParticipants` and `replaceTeams`, delete rows for the single session and insert the complete provided list in the same transaction; `participants` includes the unbounded FIFO waitlist, while persisted `team_members` is capped at the 20 active slots. For `transactUpdate`, read `processed_updates`; if absent, insert it and invoke `work` before commit. For effect claims, select due pending rows plus rows with expired leases, update them to leased with a 30-second `lease_until`, and return them from the same transaction. `rescheduleEffect` sets status back to pending and clears lease fields; `markEffectPermanentlyFailed` sets status to `failed`, stores only the truncated redacted error, and clears lease fields.

- [ ] **Step 6: Run database checks and commit**

Run without a test DB:

```powershell
npm.cmd run typecheck
npm.cmd test -- tests/integration/ydb-store.test.ts
```

Expected: typecheck PASS; integration suite is reported skipped with an explicit missing `YDB_TEST_CONNECTION_STRING` reason.

When local disposable YDB is available, run:

```powershell
$env:YDB_TEST_CONNECTION_STRING='grpc://localhost:2136/local'
$env:YDB_ANONYMOUS_CREDENTIALS='1'
npm.cmd test -- tests/integration/ydb-store.test.ts
```

Expected: all YDB contract tests PASS twice consecutively.

Commit:

```powershell
git add -- migrations/001_initial.sql src/adapters/ydb tests/integration/ydb-store.test.ts
git commit -m "feat: persist football history in YDB"
```

---

### Task 9: Route Telegram updates, flush the outbox, and expose the Yandex handler

**Files:**
- Create: `src/application/update-router.ts`
- Create: `src/application/outbox-worker.ts`
- Create: `src/handler.ts`
- Test: `tests/application/update-router.test.ts`
- Test: `tests/application/outbox-worker.test.ts`
- Test: `tests/handler.test.ts`

**Interfaces:**
- Consumes: `BotService`, `Scheduler`, `FootballStore`, `TelegramPort`, `AppConfig`.
- Produces: exported CommonJS-compatible `handler(event, context)` entrypoint at `dist/handler.handler`.

- [ ] **Step 1: Write failing update routing tests**

Create `tests/application/update-router.test.ts` with exact cases for:

- `+`, `+1`, `+2`, `-`, `-1`, and `-2` in the configured group;
- callbacks `v1:r:0..3`, `v1:r:list`, `v1:w:1..4`, `v1:w:undo`, `v1:w:finish`, `v1:w:confirm_finish`;
- `/setup`, `/status`, `/open`, `/close`, `/undo`, and `/finish`;
- a non-admin clicking a protected button receives `Только администратор` with `showAlert: true`;
- a stale callback receives `Эта кнопка уже неактуальна` and changes no state;
- every callback path calls `answerCallback` exactly once;
- unrelated group text produces no Bot API call.

Representative test:

```ts
it('routes one-tap team win and answers the callback once', async () => {
  const { router, service, telegram } = fixture();
  await router.handle({ update_id: 77, callback_query: {
    id: 'cq', from: { id: 900, first_name: 'Admin' }, data: 'v1:w:2',
    message: { message_id: 5, chat: { id: -1001, type: 'supergroup' }, date: 0 },
  } });
  expect(service.recordWin).toHaveBeenCalledWith('77', '900', 2);
  expect(telegram.answerCallback).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Implement strict Update parsing and routing**

Create `src/application/update-router.ts`. Convert all Telegram IDs through `String`. Reject unsafe numeric IDs with a logged validation error. Parse registration text only after trimming and normalizing full-width plus/minus characters. Map `-1` to current party size minus one guest and `-2` to player-only, requiring a store-backed current party view from `BotService`.

Map domain errors to short Russian callback alerts. Do not expose stack traces. `/setup` must run inside a group/supergroup. Require configured admin ID for every slash recovery command, including `/status` and `/open`. `/finish` and `v1:w:finish` only show a second confirmation keyboard; only `v1:w:confirm_finish` calls `BotService.finish`. Route `v1:r:list` and `/status` through the fresh `registrationView()` and `status()` snapshots. Ignore bot-authored messages and edits. Return success for unsupported Telegram update types.

- [ ] **Step 3: Write outbox retry tests**

Create `tests/application/outbox-worker.test.ts` proving:

- a sent effect is marked sent;
- Telegram `429` is rescheduled no earlier than `retry_after`;
- a transient failure uses delays of 30, 120, 600, then 3600 seconds;
- a permanent Telegram `400` marks the effect failed without retry, while the fourth transient attempt also enqueues one generic `admin_error` notice and continues hourly retry;
- error text stored in YDB is truncated to 500 characters and contains no token;
- registration and score effects edit stored message IDs, while missing IDs send a message and save the returned ID;
- pin failure is logged but does not reschedule an otherwise sent registration card or score panel;
- `admin_error` does not recursively enqueue another `admin_error`.

- [ ] **Step 4: Implement OutboxWorker**

Create `src/application/outbox-worker.ts` with:

```ts
export class OutboxWorker {
  constructor(
    private readonly store: FootballStore,
    private readonly telegram: TelegramPort,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}
  flush(limit = 10): Promise<{ sent: number; rescheduled: number }>;
}
```

For each leased semantic effect, load a fresh snapshot in a short read transaction, render it, send/edit through `TelegramPort`, persist a newly created message ID, then mark the effect sent. Pin newly sent registration cards and score panels. Render a zero-team `teams` effect as `Недостаточно для двух команд` with the current participant count. Mark non-rate-limit Telegram `4xx` as permanently failed; reschedule network/`429`/`5xx` failures with the tested backoff. On the fourth transient failure, enqueue exactly one generic `admin_error` with deterministic ID ``admin-error:${effect.effectId}`` and the failed effect ID as correlation ID; never put raw Telegram descriptions in that group message. Process effects sequentially to preserve visible message order; limit each invocation to 10.

- [ ] **Step 5: Write handler security and event-shape tests**

Create `tests/handler.test.ts` using a dependency-injected `createHandler(deps)` factory. Assert:

```ts
it('rejects an invalid Telegram secret before parsing the body', async () => {
  const deps = fixture();
  const response = await createHandler(deps)({
    httpMethod: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: '{bad-json',
  }, {} as never);
  expect(response.statusCode).toBe(403);
  expect(deps.router.handle).not.toHaveBeenCalled();
});

it('runs scheduler and outbox for a Yandex TimerMessage', async () => {
  const deps = fixture();
  await createHandler(deps)({ messages: [{ event_metadata: {
    event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage', event_id: 'timer-1', created_at: '2026-07-21T07:00:00Z',
  }, details: { trigger_id: 'trigger-1', payload: 'tick' } }] }, {} as never);
  expect(deps.scheduler.tick).toHaveBeenCalledOnce();
  expect(deps.outbox.flush).toHaveBeenCalledOnce();
});
```

Also test: valid secret with JSON body returns 200; invalid JSON returns 400; method other than POST returns 405; body over 1 MiB returns 413; router exception returns 500 so Telegram retries; duplicate updates return 200; secret comparison accepts only exact equal-length value; logs exclude body and headers; every unhandled error log contains an injected correlation ID but no secret.

- [ ] **Step 6: Implement the single Yandex entrypoint**

Create `src/handler.ts`. Export both `createHandler(deps)` for tests and `handler(event, context)` for Yandex. Detect timer events by `messages[0].event_metadata.event_type`; detect HTTP by `httpMethod`. For HTTP, normalize header names to lowercase, use `crypto.timingSafeEqual` only after equal-length buffers are confirmed, parse body whether Yandex supplied an object or JSON string, and run `router.handle` followed by `outbox.flush(10)`. Generate one correlation ID per invocation and include it in every structured error event and safe HTTP 500 body.

Create production dependencies once at module scope: validated config, cached YDB driver/store, system clock, `crypto.randomInt`, `crypto.randomUUID`, Telegram client, service, scheduler, router, and outbox worker. Catch initialization failure per invocation so a later cold start/retry can recover.

- [ ] **Step 7: Run all local tests and commit**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Expected: all non-cloud tests PASS, only explicitly environment-gated YDB integration tests skip, typecheck PASS, and `dist/handler.js` exists.

Commit:

```powershell
git add -- src/application/update-router.ts src/application/outbox-worker.ts src/handler.ts tests/application/update-router.test.ts tests/application/outbox-worker.test.ts tests/handler.test.ts
git commit -m "feat: expose secure Telegram serverless handler"
```

---

### Task 10: Package the function, replace the polling workflow, and automate safe deployment

**Files:**
- Modify: `tsconfig.build.json`
- Create: `scripts/package-function.ps1`
- Create: `scripts/deploy.ps1`
- Create: `scripts/set-webhook.mjs`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Delete: `.github/workflows/main.yml`
- Delete: `Procfile`
- Delete: `bot.yml`
- Delete: `requirements.txt`
- Modify: `.gitignore`
- Modify locally for secret removal: `ЗАПУСК_БОТА.md`
- Modify locally for secret removal: `football_cloudflare/ИНСТРУКЦИЯ_CLOUDFLARE.md`
- Test: `tests/scripts/set-webhook.test.ts`

**Interfaces:**
- Consumes: compiled `dist/handler.js`, `migrations/001_initial.sql`, authenticated `yc` CLI, and runtime secrets from the current PowerShell process.
- Produces: `.artifacts/function.zip`, an idempotent `deploy.ps1`, a secure webhook script, and CI that never runs the bot as a long-lived job.

- [ ] **Step 1: Verify the production-only build configuration**

Confirm `tsconfig.build.json` still contains:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "sourceMap": true,
    "declaration": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["tests", "dist", "node_modules"]
}
```

Confirm the `build` script is `tsc -p tsconfig.build.json`. Run it and verify the output entrypoint is `dist/handler.handler` and no test file appears under `dist`.

- [ ] **Step 2: Write the deterministic package script**

Create `scripts/package-function.ps1` that:

1. resolves repository root from `$PSScriptRoot`;
2. runs `npm.cmd ci`, `npm.cmd test`, `npm.cmd run typecheck`, and `npm.cmd run build`, checking `$LASTEXITCODE` after each command;
3. resolves `.artifacts` and refuses to remove anything unless its full path starts with the repository root;
4. recreates `.artifacts/function/`;
5. copies `dist/`, `package.json`, and `package-lock.json` into the staging directory;
6. creates `.artifacts/function.zip` with `Compress-Archive` so `dist/handler.js` is at the zip root path `dist/handler.js`;
7. prints only the zip path, byte size, and SHA-256, never environment variables.

Add `dist/`, `.artifacts/`, `node_modules/`, `.env*`, `*.key.json`, and `*.sqlite*` to `.gitignore`, while allowing `.env.example` if one is later documented.

- [ ] **Step 3: Write failing webhook script tests**

Create `tests/scripts/set-webhook.test.ts` around exported `setWebhook(fetcher, input)`. Test the exact request fields:

```ts
expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
  url: 'https://functions.yandexcloud.net/function-id?tag=stable',
  secret_token: 'valid_secret_1234567890',
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: false,
});
```

Also assert that a failed Bot API response throws without including the token, and that `getWebhookInfo` validates the returned URL and `pending_update_count`.

- [ ] **Step 4: Implement the webhook utility**

Create `scripts/set-webhook.mjs`. Read `BOT_TOKEN`, `WEBHOOK_SECRET`, and `FUNCTION_URL` from environment, validate them, then POST `setWebhook`. Immediately call `getWebhookInfo` and fail unless URL matches and `last_error_message` is absent. Export functions for tests and execute `main()` only when run directly. Do not print the token or raw API URL containing it.

- [ ] **Step 5: Implement idempotent Yandex deployment**

Create `scripts/deploy.ps1` with `Set-StrictMode -Version Latest` and `$ErrorActionPreference = 'Stop'`. Require nonempty `BOT_TOKEN`, `WEBHOOK_SECRET`, and `ADMIN_IDS`; require `yc config get folder-id` to succeed. Use fixed resource names:

```powershell
$FunctionName = 'friday-football-bot'
$DatabaseName = 'friday-football-bot-db'
$ServiceAccountName = 'friday-football-bot-runtime'
$TriggerName = 'friday-football-bot-every-minute'
```

Look up resources with these exact commands and create only when the matching command reports not-found:

```powershell
yc iam service-account get --name $ServiceAccountName --format json
yc ydb database get $DatabaseName --format json
yc serverless function get $FunctionName --format json
yc serverless trigger get $TriggerName --format json
```

Use these creation commands:

```powershell
yc iam service-account create --name $ServiceAccountName
yc ydb database create $DatabaseName --serverless --sls-provisioned-rcu 0 --sls-storage-size 1GB --deletion-protection
yc serverless function create --name $FunctionName
```

Grant the runtime service account `ydb.editor` on this database, not the whole cloud:

```powershell
yc ydb database add-access-binding $DatabaseName --role ydb.editor --service-account-id $ServiceAccountId
```

Package the app. Read the full connection string from `(yc ydb database get $DatabaseName --format json | ConvertFrom-Json).endpoint`. Before deployment, set a short-lived local `YDB_ACCESS_TOKEN_CREDENTIALS` from `yc iam create-token`, run `npm.cmd run migrate`, and remove that process variable in a `finally` block.

Create a function version using:

```powershell
yc serverless function version create `
  --function-name $FunctionName `
  --runtime nodejs22 `
  --entrypoint dist/handler.handler `
  --memory 256MB `
  --execution-timeout 15s `
  --concurrency 1 `
  --service-account-id $ServiceAccountId `
  --source-path '.artifacts/function.zip' `
  --environment "BOT_TOKEN=$env:BOT_TOKEN,WEBHOOK_SECRET=$env:WEBHOOK_SECRET,ADMIN_IDS=$env:ADMIN_IDS,YDB_CONNECTION_STRING=$YdbConnectionString,YDB_METADATA_CREDENTIALS=1"
```

Capture JSON output in a variable and print only version/function IDs and status; do not echo the environment section. Before creating the version, resolve the previous stable version, if any, with `yc serverless function version get-by-tag --function-name $FunctionName --tag stable --format json` and retain its ID for rollback output. After version creation:

1. wait until the returned version status is `ACTIVE`;
2. run `yc serverless function version set-tag --id $NewVersionId --tag candidate`;
3. allow unauthenticated function invocation;
4. send a private script-owned HTTP probe to `https://functions.yandexcloud.net/$FunctionId?tag=candidate`: wrong secret must return 403 and a correct-secret body `{"update_id":-1}` must return 200;
5. only after both probes pass, atomically move the `stable` tag with `yc serverless function version set-tag --id $NewVersionId --tag stable`.

Never print the probe headers or response bodies. Then run:

```powershell
yc serverless function allow-unauthenticated-invoke $FunctionName
yc serverless function add-access-binding $FunctionName --role functions.functionInvoker --service-account-id $ServiceAccountId
yc serverless trigger create timer `
  --name $TriggerName `
  --cron-expression '* * * * ? *' `
  --payload 'tick' `
  --invoke-function-name $FunctionName `
  --invoke-function-tag stable `
  --invoke-function-service-account-id $ServiceAccountId
```

Create the trigger only when its exact lookup failed. The timer is private even though the webhook endpoint is public.

Set `$env:FUNCTION_URL = "https://functions.yandexcloud.net/$FunctionId?tag=stable"` and run `node scripts/set-webhook.mjs`. Because both Telegram and the timer target `stable`, creating a later `$latest` version cannot switch production before its probes pass. Print the stable function URL, new version ID, previous stable version ID (when present), exact rollback command `yc serverless function version set-tag --id $PreviousStableVersionId --tag stable`, and the next manual action `/setup`, but no secrets.

- [ ] **Step 6: Replace the broken GitHub workflow with CI only**

Delete `.github/workflows/main.yml`, `Procfile`, `bot.yml`, and `requirements.txt`. Create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run typecheck
      - run: npm run build
```

No scheduled workflow and no `|| true` are allowed.

- [ ] **Step 7: Remove exposed tokens from every local instruction file**

Run this secret scan without printing matching lines:

```powershell
$matches = rg -l --hidden --glob '!.git/**' --glob '!node_modules/**' '[0-9]{8,12}:[A-Za-z0-9_-]{30,}' .
$matches
```

For each returned documentation/config file, replace the literal token with text instructing the owner to create a new token through BotFather and pass it only through `BOT_TOKEN`. Do not alter unrelated prose. Run the same scan again.

Expected: no matching file. Then revoke the previously exposed token in BotFather before any production webhook is set.

- [ ] **Step 8: Write the operator README**

Create `README.md` in Russian with:

- supported product flow and admin commands;
- prerequisites: Node 22, `yc` CLI, active Yandex billing account, new BotFather token, numeric admin ID;
- BotFather `/setprivacy → Disable` requirement for the optional `+`, `+1`, `+2`, `-`, `-1`, `-2` group-text fallback; inline buttons continue to work independently;
- exact PowerShell environment commands for the current process;
- `./scripts/deploy.ps1` command;
- add bot to group, grant pin permission, run `/setup`, then `/status`;
- rollback by moving the `stable` tag to the recorded `$PreviousStableVersionId` with `yc serverless function version set-tag --id $PreviousStableVersionId --tag stable`, without changing the Telegram webhook, timer, or YDB;
- YDB automatic two-day backups;
- free-tier assumptions and a 10 ₽ budget-alert checklist;
- troubleshooting for webhook errors, missing pin permission, timer delay, and duplicate callbacks;
- warning that budget alerts notify but do not hard-stop billing.

- [ ] **Step 9: Run packaging and CI-equivalent checks**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
& .\scripts\package-function.ps1
Get-FileHash -Algorithm SHA256 '.artifacts\function.zip'
```

Expected: tests/typecheck/build PASS, the zip exists, and listing it shows `dist/handler.js`, `package.json`, and `package-lock.json` but no tests, `.env`, Git directory, local instructions, or token.

- [ ] **Step 10: Commit deployment and CI files exactly**

```powershell
git add -- tsconfig.build.json scripts/package-function.ps1 scripts/deploy.ps1 scripts/set-webhook.mjs .github/workflows/ci.yml README.md .gitignore tests/scripts/set-webhook.test.ts
git add -u -- .github/workflows/main.yml Procfile bot.yml requirements.txt
git commit -m "ops: deploy football bot to Yandex Cloud"
```

Do not stage `bot.py`, `football_cloudflare/`, `football_bot_logic.html`, or unrelated legacy instruction files.

---

### Task 11: Perform full verification, deploy production, and record the handoff

**Files:**
- Create: `docs/operations/production-checklist.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: active Yandex Cloud account, newly rotated Telegram token, numeric admin Telegram ID, and a test/production Telegram group.
- Produces: live webhook, working minute timer, initialized YDB, verified weekly workflow, and a non-secret operations record.

- [ ] **Step 1: Run the complete local quality gate**

Run each command independently and stop on the first failure:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run test:coverage
npm.cmd run typecheck
npm.cmd run build
git diff --check
git status --short
```

Expected: all tests PASS; coverage meets configured thresholds; typecheck/build PASS; no whitespace errors. `git status` may still show the user's pre-existing legacy changes, but no implementation file may be unstaged.

- [ ] **Step 2: Rotate credentials and deploy**

In BotFather revoke the exposed token, issue a new token, and disable privacy mode so the bot can receive the approved text fallback in its group. In the current PowerShell process set the new values without writing a file:

```powershell
$env:BOT_TOKEN = Read-Host 'New Telegram bot token'
$env:WEBHOOK_SECRET = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
$env:ADMIN_IDS = Read-Host 'Numeric Telegram admin IDs, comma-separated'
& .\scripts\deploy.ps1
```

Expected: migrations succeed, candidate probes pass, function version becomes `ACTIVE` and owns `stable`, unauthenticated invocation is enabled only for the function, timer targets `stable`, and `getWebhookInfo` reports the tagged Yandex function URL without an error.

- [ ] **Step 3: Configure monitoring and cost guardrails**

In Yandex Cloud create:

1. a billing budget notification at 10 ₽ for the bot's billing account;
2. an error-rate alert for Cloud Function execution errors over 0 in a five-minute window;
3. a timer trigger failure alert;
4. retention settings that remain inside the free Cloud Logging allowance.

Record only alert names and creation date in `docs/operations/production-checklist.md`; do not record account IDs, email addresses, or tokens.

- [ ] **Step 4: Execute the production smoke test**

In the chosen Telegram group:

1. add the bot, confirm BotFather privacy mode is disabled, and grant permission to pin messages;
2. send `/setup` as configured admin and verify another user is rejected;
3. run `/open` and confirm one pinned registration card;
4. register ten Telegram accounts/test fixtures using `+`, `+1`, buttons, and cancellations;
5. fill beyond 20 with fixtures, cancel one active slot, and verify FIFO promotion notification;
6. run `/close`, verify full teams of five and no waitlisted member in a team;
7. press team-win buttons at least three times, repeat one captured update, and confirm no duplicate win;
8. press undo and confirm only the latest active win disappears;
9. finish with confirmation and verify daily plus cumulative personal tables;
10. press a stale win button and verify it is rejected;
11. invoke the timer twice and verify no duplicate scheduled message;
12. run `/status` and confirm healthy state without secret output.

Expected: every criterion in section 2 of the approved design is observed.

- [ ] **Step 5: Verify persistence and rollback**

Create a new function version from the same zip to force a cold start, assign it `candidate`, probe it, move `stable` to it, then call `/status` and verify the completed session and leaderboard remain. Temporarily move `stable` to the recorded previous tested version with `yc serverless function version set-tag`, verify `/status`, then return it to the new version. The webhook URL and timer configuration must remain unchanged; do not delete or recreate YDB during rollback.

- [ ] **Step 6: Record non-secret production evidence**

Create `docs/operations/production-checklist.md` with checkboxes and actual pass dates for: token rotated, webhook URL verified, timer active, function `ACTIVE`, migration version 1, `/setup`, registration, reserve promotion, teams, wins, undo, finish, cold-start persistence, monitoring, and budget notification. Record resource names only, not resource IDs or secrets.

Update README's deployment status to `Production verified` with the date.

- [ ] **Step 7: Final verification commit**

```powershell
git add -- docs/operations/production-checklist.md README.md
git commit -m "docs: record production football bot verification"
git log --oneline -12
git status --short
```

Expected: the new documentation commit is present; only unrelated pre-existing legacy changes remain unstaged.

## Final Acceptance Checklist

- [ ] Every requirement and accepted assumption in the design spec maps to a passing test or a production smoke-test step above.
- [ ] `npm test`, coverage, typecheck, and production build pass from a clean install.
- [ ] YDB migrations are idempotent and production schema version is 1.
- [ ] Telegram webhook rejects the wrong secret and accepts the correct secret.
- [ ] Duplicate updates, concurrent wins, and concurrent schedule ticks do not duplicate state.
- [ ] Registration, reserve promotion, team formation, wins, undo, finish, and cumulative leaderboard work in the real group.
- [ ] Function cold start preserves all data and the timer catches up a missed due transition.
- [ ] Old scheduled GitHub polling is removed and GitHub Actions only performs CI.
- [ ] The exposed old token is revoked and no token-shaped value remains in the worktree or Git history added by this implementation.
- [ ] Yandex resources remain within free-tier configuration and a 10 ₽ budget notification is active.
- [ ] The bot is live, monitored, documented, and handed off to the owner.
