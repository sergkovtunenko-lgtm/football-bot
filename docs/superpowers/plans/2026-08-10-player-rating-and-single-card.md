# Player Rating and Single Registration Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Telegram names consistently and publish a readable cumulative player rating with wins and completed football evenings while preserving the existing one-card weekly workflow.

**Architecture:** Keep registration, teams, win buttons, the outbox, and the YDB schema unchanged. Add one pure player-label helper, extend the existing scoring aggregation with completed team-member snapshots, and make the Telegram renderer return one or more bounded rating messages. Application code reads YDB sequentially within each transaction and feeds the pure domain functions.

**Tech Stack:** Node.js 22, TypeScript 7, Vitest 4, Telegram Bot API HTML messages, Yandex Cloud Functions, YDB Serverless, existing Cloudflare ingress/egress gateway.

## Global Constraints

- The approved specification is `docs/superpowers/specs/2026-08-10-player-rating-and-single-card-design.md`.
- Prefer a nonblank Telegram first/last name; use `@username` only when no name exists; never show both.
- Do not add draws, match scores, opponents, MVP, win percentage, images, a website, or new administrator buttons.
- A rating “game” is one completed football evening, not one five-minute match.
- Count a team reserve as attending; exclude the general waitlist and guests without their own Telegram profile.
- Keep players with zero wins when they have at least one completed evening.
- Rank by wins only; equal wins share rank and sort by displayed name, then Telegram user ID.
- Keep only Tuesday 10:00 Moscow opening and Friday 20:55 Moscow closing; do not restore reminders or `/remind`.
- Do not add or migrate YDB tables. Preserve all current production sessions, teams, wins, and awards; never run `reset:production`.
- Never send test messages, press buttons, edit messages, or pin messages in the production group during verification.
- All YDB calls inside one transaction must remain sequential; do not introduce `Promise.all` over transaction methods.

## File Structure

- Create `src/domain/player-label.ts`: pure selection and normalization of the visible player label.
- Create `tests/domain/player-label.test.ts`: name, username, historical-name, and neutral-fallback contract.
- Modify `src/application/update-router.ts`: apply the shared label rule when a Telegram user registers.
- Modify `tests/application/update-router.test.ts`: verify username fallback at the Telegram boundary.
- Modify `src/domain/scoring.ts`: add `evenings` and seed rating rows from completed team-member snapshots.
- Modify `tests/domain/scoring.test.ts`: cover zero-win players, reserves, waitlist exclusion by construction, guests, deduplication, unfinished sessions, reversed wins, and ranks.
- Modify `src/application/bot-service.ts`: load completed team members sequentially and pass full player profiles to scoring.
- Modify `tests/application/bot-service.test.ts`: verify the finished session immediately includes winners and zero-win attendees with one evening.
- Modify `src/application/outbox-worker.ts`: build current/historical names safely, load completed rosters sequentially, and deliver every rating page.
- Modify `tests/application/outbox-worker.test.ts`: verify completed roster data, username fallback, all rating pages, and transaction-call serialization.
- Modify `src/adapters/telegram/render.ts`: render medals, Russian word forms, two-line rows, and bounded pages.
- Modify `tests/telegram/render.test.ts`: verify exact presentation, escaping, word forms, ties, empty state, and pagination.
- Read-only verification: `src/domain/schedule.ts`, `tests/domain/schedule.test.ts`, `scripts/deploy.ps1`, and `README.md`.

---

### Task 1: Normalize the visible Telegram player name

**Files:**
- Create: `src/domain/player-label.ts`
- Create: `tests/domain/player-label.test.ts`
- Modify: `src/application/update-router.ts:347-351`
- Modify: `tests/application/update-router.test.ts`

**Interfaces:**
- Consumes: Telegram `first_name`, optional `last_name`, and optional `username` parsed by `UpdateRouter`.
- Produces: `playerLabel(source: PlayerLabelSource, historicalDisplayName?: string): string`, used by registration and later rating assembly.

- [ ] **Step 1: Write the failing pure-domain tests**

Create `tests/domain/player-label.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { playerLabel } from '../../src/domain/player-label';

describe('playerLabel', () => {
  it('prefers and trims the Telegram name without appending username', () => {
    expect(playerLabel({ displayName: '  Сергей Ковтуненко  ', username: 'sergey' }))
      .toBe('Сергей Ковтуненко');
  });

  it('uses one leading @ when the name is blank', () => {
    expect(playerLabel({ displayName: ' ', username: 'football_player' })).toBe('@football_player');
    expect(playerLabel({ displayName: '', username: '@football_player' })).toBe('@football_player');
  });

  it('uses a historical name before the neutral fallback', () => {
    expect(playerLabel({}, '  Старое имя  ')).toBe('Старое имя');
    expect(playerLabel({ displayName: ' ', username: ' ' }, ' ')).toBe('Игрок');
  });
});
```

- [ ] **Step 2: Run the new test and confirm the missing-module failure**

Run: `npm.cmd test -- tests/domain/player-label.test.ts`

Expected: FAIL because `src/domain/player-label.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure helper**

Create `src/domain/player-label.ts`:

```ts
export interface PlayerLabelSource {
  displayName?: string;
  username?: string;
}

export function playerLabel(source: PlayerLabelSource, historicalDisplayName?: string): string {
  const name = source.displayName?.trim();
  if (name) return name;
  const username = source.username?.trim().replace(/^@+/, '');
  if (username) return `@${username}`;
  return historicalDisplayName?.trim() || 'Игрок';
}
```

- [ ] **Step 4: Make registration use the helper and add a boundary test**

Import `playerLabel` in `src/application/update-router.ts` and change `playerFrom` to compose first and last name, then normalize it:

```ts
function playerFrom(user: ParsedUser): PlayerProfile {
  const displayName = playerLabel({
    displayName: [user.firstName, user.lastName].filter((part) => part !== undefined).join(' '),
    username: user.username,
  });
  return user.username === undefined
    ? { telegramUserId: user.id, displayName }
    : { telegramUserId: user.id, displayName, username: user.username };
}
```

Add `import type { PlayerProfile } from '../domain/model';` rather than repeating its structural return type. In `tests/application/update-router.test.ts`, add a case that sends a registration update with `first_name: '   '` and `username: 'only_username'`, then expects:

```ts
expect(service.setParty).toHaveBeenCalledWith('77', {
  telegramUserId: '7',
  displayName: '@only_username',
  username: 'only_username',
}, 1);
```

- [ ] **Step 5: Run focused tests**

Run: `npm.cmd test -- tests/domain/player-label.test.ts tests/application/update-router.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the independently working name rule**

```powershell
git add -- src/domain/player-label.ts tests/domain/player-label.test.ts src/application/update-router.ts tests/application/update-router.test.ts
git commit -m "feat: normalize Telegram player labels"
```

---

### Task 2: Count completed football evenings in the cumulative rating

**Files:**
- Modify: `src/domain/scoring.ts`
- Modify: `tests/domain/scoring.test.ts`
- Modify: `src/application/bot-service.ts`
- Modify: `tests/application/bot-service.test.ts`
- Modify: `src/application/outbox-worker.ts`
- Modify: `tests/application/outbox-worker.test.ts`

**Interfaces:**
- Consumes: `WinEvent[]`, `WinAward[]`, completed session IDs, `TeamMember[]` snapshots, and `Map<string, PlayerProfile>`.
- Produces: `LeaderboardRow { rank, telegramUserId, displayName, wins, evenings }` and the extended `buildLeaderboard(events, awards, completedSessionIds, teamMembers, currentPlayers)` function.

- [ ] **Step 1: Replace the scoring expectations with the approved rating contract**

In `tests/domain/scoring.test.ts`, update existing `buildLeaderboard` calls to pass team members and player profiles. Add one focused test whose fixtures include:

```ts
const completedMembers: TeamMember[] = [
  { ...member('1'), sessionId: 'done', teamNumber: 1, role: 'starter' },
  { ...member('1'), participantId: 'duplicate', sessionId: 'done', teamNumber: 2, role: 'reserve' },
  { ...member('2', 'reserve'), sessionId: 'done', teamNumber: 1 },
  { ...member('3'), sessionId: 'done', teamNumber: 2 },
  { ...member('4'), sessionId: 'open', teamNumber: 1 },
  {
    participantId: 'guest', sessionId: 'done', ownerUserId: '9', displayName: 'Гость',
    kind: 'guest', guestNumber: 1, queuePosition: 9n, rosterStatus: 'active',
    teamNumber: 1, role: 'starter',
  },
];
```

Assert that player `1` has two wins and one evening, player `2` has zero wins and one evening despite being a team reserve, player `3` has zero wins and one evening, and neither the unfinished player nor the guest appears. Retain the active/reversed award cases and assert competition ranks `1, 2, 2` or `1, 1, 3` according to the chosen win fixtures. Add a separate award without a matching member snapshot and assert its historical win remains visible with `evenings: 0`.

- [ ] **Step 2: Run the scoring tests and confirm signature/result failures**

Run: `npm.cmd test -- tests/domain/scoring.test.ts`

Expected: FAIL because `LeaderboardRow` has no `evenings` and `buildLeaderboard` does not seed rows from team members.

- [ ] **Step 3: Extend the pure rating aggregation**

In `src/domain/scoring.ts`:

```ts
import type { PlayerProfile, TeamMember, WinAward, WinEvent } from './model';
import { playerLabel } from './player-label';

export interface LeaderboardRow {
  rank: number;
  telegramUserId: string;
  displayName: string;
  wins: number;
  evenings: number;
}
```

Change the function signature to:

```ts
export function buildLeaderboard(
  events: readonly WinEvent[],
  awards: readonly WinAward[],
  completedSessionIds: ReadonlySet<string>,
  teamMembers: readonly TeamMember[],
  currentPlayers: ReadonlyMap<string, PlayerProfile>,
): LeaderboardRow[]
```

Build rows in two passes. First, filter to completed-session members where `kind === 'player'` and `telegramUserId` exists. Deduplicate evenings with a `Set` key `${sessionId}:${telegramUserId}`, seed `wins: 0`, and increment `evenings` once. Second, process only active awards whose event belongs to a completed session, preserving awards without a member snapshot with `evenings: 0`. Resolve every label through:

```ts
const labelFor = (telegramUserId: string, historicalDisplayName: string): string =>
  playerLabel(currentPlayers.get(telegramUserId) ?? {}, historicalDisplayName);
```

Sort by wins descending, then `displayName.localeCompare(..., 'ru')`, then Telegram user ID. Keep the existing competition-rank rule based only on wins.

- [ ] **Step 4: Run scoring tests until the pure contract passes**

Run: `npm.cmd test -- tests/domain/scoring.test.ts`

Expected: PASS, including zero-win players, one-evening deduplication, reserve inclusion, guest exclusion, historical awards, reversed wins, and tie ranks.

- [ ] **Step 5: Feed completed roster snapshots from BotService sequentially**

In `src/application/bot-service.ts`, update `completedLeaderboard`:

```ts
async function completedLeaderboard(tx: FootballTransaction): Promise<LeaderboardRow[]> {
  const events = await tx.listWinEvents();
  const awards = await tx.listWinAwards();
  const completedSessionIds = await tx.listCompletedSessionIds();
  const players = await tx.listPlayers();
  const members: TeamMember[] = [];
  for (const completedSessionId of completedSessionIds) {
    members.push(...await tx.listTeamMembers(completedSessionId));
  }
  return buildLeaderboard(
    events,
    awards,
    completedSessionIds,
    members,
    new Map(players.map((player) => [player.telegramUserId, player])),
  );
}
```

Import `TeamMember` as a type. Do not parallelize the loop. In `tests/application/bot-service.test.ts`, strengthen the completed-session test: after forming two teams, give team 1 one win, finish, and assert all registered players appear with `evenings: 1`; winners have `wins: 1` and the other team has `wins: 0`. Keep `rejectConcurrentTransactionCalls()` enabled in its existing regression test.

- [ ] **Step 6: Feed the same data into final outbox views**

In `src/application/outbox-worker.ts`, import `PlayerProfile`, `TeamMember`, and `playerLabel`. In `finalViews`, build `currentPlayers` from `listPlayers()`, load each completed session’s team members sequentially, and call the extended `buildLeaderboard` signature. For daily winner names, replace the raw string map with:

```ts
const profiles = new Map(players.map((player) => [player.telegramUserId, player]));
const historicalNames = new Map(awards.map((award) => [award.telegramUserId, award.displayName]));
const displayName = playerLabel(
  profiles.get(telegramUserId) ?? {},
  historicalNames.get(telegramUserId),
);
```

Update `tests/application/outbox-worker.test.ts` so the finished-session fixture stores actual `TeamMember` rows instead of an empty member list. Add a player profile with blank `displayName` and a username and assert the rendered final output contains `@username`, not an empty label.

- [ ] **Step 7: Run all affected aggregation and application tests**

Run:

```powershell
npm.cmd test -- tests/domain/scoring.test.ts tests/application/bot-service.test.ts tests/application/outbox-worker.test.ts
npm.cmd run typecheck
```

Expected: all selected tests and typecheck PASS; the transaction-concurrency regression remains green.

- [ ] **Step 8: Commit the complete evenings calculation**

```powershell
git add -- src/domain/scoring.ts tests/domain/scoring.test.ts src/application/bot-service.ts tests/application/bot-service.test.ts src/application/outbox-worker.ts tests/application/outbox-worker.test.ts
git commit -m "feat: count completed football evenings"
```

---

### Task 3: Render and deliver the approved Telegram rating

**Files:**
- Modify: `src/adapters/telegram/render.ts`
- Modify: `tests/telegram/render.test.ts`
- Modify: `src/application/outbox-worker.ts`
- Modify: `tests/application/outbox-worker.test.ts`

**Interfaces:**
- Consumes: `readonly LeaderboardRow[]` from Task 2.
- Produces: `renderLeaderboardPages(rows: readonly LeaderboardRow[]): readonly string[]`, where every string is at most 4096 characters and together the pages contain every row in order.

- [ ] **Step 1: Write exact renderer tests before changing production code**

In `tests/telegram/render.test.ts`, replace `renderLeaderboard` imports and calls with `renderLeaderboardPages`. Add assertions for:

```ts
const [rating] = renderLeaderboardPages([
  { rank: 1, telegramUserId: '1', displayName: '<Сергей>', wins: 12, evenings: 3 },
  { rank: 1, telegramUserId: '2', displayName: 'Вячеслав', wins: 1, evenings: 1 },
  { rank: 3, telegramUserId: '3', displayName: '@football_player', wins: 0, evenings: 5 },
]);

expect(rating).toContain('<b>🏆 РЕЙТИНГ СЕЗОНА</b>');
expect(rating).toContain('🥇 &lt;Сергей&gt;');
expect(rating).toContain('🏆 12 побед · 📅 3 вечера');
expect(rating).toContain('🏆 1 победа · 📅 1 вечер');
expect(rating).toContain('🥉 @football_player');
expect(rating).toContain('🏆 0 побед · 📅 5 вечеров');
```

Add a parameterized word-form test for `1, 2, 5, 11, 21`. Generate at least 100 uniquely named rows with long safe names and assert:

```ts
const pages = renderLeaderboardPages(rows);
expect(pages.length).toBeGreaterThan(1);
expect(pages.every((page) => page.length <= 4096)).toBe(true);
expect(pages[0]).toContain('1/');
expect(pages.at(-1)).toContain(`${pages.length}/${pages.length}`);
for (const row of rows) expect(pages.join('\n')).toContain(row.displayName);
```

The empty call must return one message containing `Пока нет завершённых футбольных вечеров.`

- [ ] **Step 2: Run renderer tests and confirm the missing-export/shape failure**

Run: `npm.cmd test -- tests/telegram/render.test.ts`

Expected: FAIL because `renderLeaderboardPages` does not exist and current rows have no two-line format.

- [ ] **Step 3: Implement the bounded Telegram renderer**

In `src/adapters/telegram/render.ts`, add focused private helpers:

```ts
const LEADERBOARD_BODY_LIMIT = 3900;
const LEADERBOARD_NAME_LIMIT = 128;

function russianCount(value: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(value) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function rankMarker(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `${rank}.`;
}
```

Render each row as two lines. Truncate only the rendering copy of a defensive overlong name before HTML escaping; never modify stored data:

```ts
function leaderboardEntry(row: LeaderboardRow): string {
  const name = escapeHtml(row.displayName.slice(0, LEADERBOARD_NAME_LIMIT));
  return [
    `${rankMarker(row.rank)} ${name}`,
    `   🏆 ${row.wins} ${russianCount(row.wins, 'победа', 'победы', 'побед')} · `
      + `📅 ${row.evenings} ${russianCount(row.evenings, 'вечер', 'вечера', 'вечеров')}`,
  ].join('\n');
}
```

Implement `renderLeaderboardPages` by greedily adding complete entries to a body until adding the next entry would exceed `LEADERBOARD_BODY_LIMIT`. Never split an entry. Then add `<b>🏆 РЕЙТИНГ СЕЗОНА</b>` for one page or `<b>🏆 РЕЙТИНГ СЕЗОНА · N/TOTAL</b>` for multiple pages. Keep a final invariant check that every completed HTML string is at most 4096 characters; throw an internal error if the invariant is violated rather than asking Telegram to accept invalid output.

- [ ] **Step 4: Run renderer tests until all presentation cases pass**

Run: `npm.cmd test -- tests/telegram/render.test.ts`

Expected: PASS for medals, competition ranks, escaped names, Russian forms, zero wins, empty state, and pagination.

- [ ] **Step 5: Deliver every rating page from the existing final-results effect**

In `src/application/outbox-worker.ts`, replace the singular renderer import and expand pages into prepared messages:

```ts
case 'final_results': {
  const { daily, leaderboard } = await finalViews(tx, effect.sessionId);
  return {
    chatId: groupChatId,
    messages: [
      { html: renderDailyResults(daily) },
      ...renderLeaderboardPages(leaderboard).map((html) => ({ html })),
    ],
  };
}
```

In `tests/application/outbox-worker.test.ts`, seed enough completed player members to force multiple rating pages. Assert the first sent message is the daily summary, every remaining message is at most 4096 characters, all players appear once across rating pages, and the outbox effect is marked sent only after all pages succeed. Retain retry tests to ensure a failure on any page reschedules the effect.

- [ ] **Step 6: Run focused rendering and delivery tests**

Run:

```powershell
npm.cmd test -- tests/telegram/render.test.ts tests/application/outbox-worker.test.ts
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the Telegram rating presentation**

```powershell
git add -- src/adapters/telegram/render.ts tests/telegram/render.test.ts src/application/outbox-worker.ts tests/application/outbox-worker.test.ts
git commit -m "feat: render paginated season rating"
```

---

### Task 4: Verify the complete weekly flow and deploy without touching the group

**Files:**
- Verify: `src/domain/schedule.ts`
- Verify: `tests/domain/schedule.test.ts`
- Verify: `src/application/update-router.ts`
- Verify: `scripts/deploy.ps1`
- Verify: `README.md`
- No production data files or schema migrations are created.

**Interfaces:**
- Consumes: the three implementation commits, existing protected deployment credentials, and the current `stable` Yandex function.
- Produces: a tested build and a safely promoted production function version; no Telegram group activity is generated during deployment.

- [ ] **Step 1: Re-run the no-reminders and one-card regression suite**

Run:

```powershell
npm.cmd test -- tests/domain/schedule.test.ts tests/application/update-router.test.ts tests/application/outbox-worker.test.ts
```

Expected: PASS. The schedule opens Tuesday at `07:00 UTC` (`10:00 Europe/Moscow`), emits no Wednesday/Thursday/Friday reminder, closes Friday at `17:55 UTC` (`20:55 Europe/Moscow`), `/remind` is ignored, and repeated registration effects edit the saved registration message instead of creating another card.

- [ ] **Step 2: Run the complete local quality gate**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
git status --short
```

Expected: all tests PASS, typecheck and production build PASS, no whitespace errors, and the worktree is clean. YDB integration tests may skip only when their documented test connection is absent.

- [ ] **Step 3: Review the exact implementation diff against the approved scope**

Run:

```powershell
git diff 185a652..HEAD --stat
git diff 185a652..HEAD -- src tests
```

Confirm every changed line maps to name fallback, evening aggregation, rating presentation, pagination, or tests. Confirm there is no schema migration, draw tracking, new button, reminder path, secret, reset call, or unrelated refactor.

- [ ] **Step 4: Deploy through the existing candidate-first production script**

Use the existing protected environment without printing its values. Do not run `npm.cmd run reset:production`. Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\deploy.ps1"
```

Expected: the script builds the package, applies only idempotent existing migrations, creates an `ACTIVE` candidate, passes its closed HTTP probes, verifies the Cloudflare gateway with non-message methods, prints the previous stable version ID and rollback command, then moves `stable` to the candidate. No `sendMessage`, `editMessage`, callback, pin, timer invocation, or test update is sent to the production group.

- [ ] **Step 5: Perform read-only post-deployment checks**

Using the resource names already documented in `README.md`, read the active Yandex function version/tag and timer configuration. Confirm the timer still invokes `stable` every minute and that the webhook/gateway status has no pending error. Do not call Telegram group methods and do not query or expose player rows, tokens, account IDs, or message text.

Expected: the new version owns `stable`, the timer is active, Cloudflare/Yandex probes are healthy, and existing production game data remains intact.

- [ ] **Step 6: Preserve rollback information and hand off the organic verification**

Retain the previous stable version ID from the deploy output. If infrastructure checks fail, execute only the printed `set-tag` rollback command; do not alter YDB, the webhook, or the timer. If checks pass, make no group post. The first visible verification is the normal Tuesday 10:00 card, followed by Friday 20:55 teams and the new rating after the administrator finishes the evening.

Expected: production is updated without disturbing the group, and rollback remains one tag change away.

## Completion Checklist

- [ ] Telegram registration stores the preferred visible name and falls back to `@username` only when necessary.
- [ ] Registration, team lists, daily results, and cumulative rating use the same visible labels.
- [ ] Every completed team participant receives exactly one evening; team reserves count and general waitlist/guests do not.
- [ ] Zero-win attendees appear in the cumulative rating.
- [ ] Active completed wins remain cumulative; reversed and unfinished wins are excluded.
- [ ] Rating ranks depend only on wins and render the approved two-line Telegram layout.
- [ ] Long ratings are split into ordered messages no longer than 4096 characters.
- [ ] Tuesday opening, Friday closing, one pinned card, and no reminders remain covered by tests.
- [ ] All tests, typecheck, build, and diff checks pass.
- [ ] Production deploy preserves YDB data and produces no test activity in the group.
