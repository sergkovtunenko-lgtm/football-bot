# Friday cutoff and payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this approved plan task-by-task.

**Goal:** Cancel only the missed 2026-10-16 session, announce withdrawals, close registration at 19:00 Moscow with an equal-share payment notice, and keep teams at 20:55.

**Architecture:** Reuse the D1 store and transactional outbox. Split the existing scheduler close into a registration cutoff and later team formation; immutable payment/withdrawal payloads preserve the facts when queued. No new hosting, dependencies, or credentials.

**Tech Stack:** TypeScript, Vitest, Luxon, Cloudflare Workers/D1/Queues.

**Spec:** User-approved chat plan on 2026-10-19: under 20 active people divide 9950 RUB by active headcount; exactly 20 divide 13200 RUB by 20. Exclude waitlist, show kopecks, preserve Tuesday opening and 20:55 teams, do not delete Telegram messages.

## Global Constraints

- Preserve other sessions, global players, admin controls, incomplete-team formation, and existing unrelated untracked plan.
- Back up production records privately before cancelling 2026-10-16; retain a cancelled tombstone, not an active session.
- Do not generate test messages/participants in the production Telegram group.

## Review Focus

- A delayed tick after 20:55 must perform cutoff before teams exactly once.
- Zero players must not produce a division by zero or a demand for payment.
- Guests count as people; waitlist does not pay; an incomplete fourth team uses 9950.
- Withdrawals must preserve removed names, escape HTML, and avoid repeat notices on duplicate updates.
- The 19:00 cutoff must reject changes even before a delayed timer executes; cancellation suppresses both stages.

### Task 1: Registration cutoff, payment, and team stages

**Files:** `src/domain/schedule.ts`, `src/application/scheduler.ts`, `src/application/bot-service.ts`, `src/application/views.ts`, `src/ports/store.ts`, `src/application/outbox-worker.ts`, `src/adapters/telegram/render.ts`; their tests and `tests/integration/d1-store.test.ts`.

**Interfaces:** schedule adds `teams` action. `closeRegistration(tx, sessionId, nowIso, newId)` freezes registration and queues a payment snapshot; `formSessionTeams(tx, sessionId, nowIso, random, newId)` creates teams from closed registration. Existing manual `closeNow` remains an administrator recovery action. Outbox adds `payment_notice` with `participantCount`.

- [x] Write failing tests for 19:00 cutoff, 20:55 teams, catch-up/deduplication, closed keyboard, payment values 0/10/15/19/20, waitlist and guest counting, and cancelled sessions.
- [x] Run tests; expect missing cutoff/payment behavior to fail.
- [x] Implement the minimal split, payment rendering, and deadline enforcement.
- [x] Run focused tests, full suite, typecheck and build; expect no failures.

### Task 2: Visible removals

**Interfaces:** add `withdrawal_notice {sessionId, displayNames: string[]}` to the transactional outbox, used by both voluntary reductions and admin absence correction.

- [x] Write/run failing tests for removing player/guest, no removal on additions, update deduplication, and escaped rendered names.
- [x] Snapshot removed names and enqueue notices in the same transaction as removal.
- [x] Run focused and full verification; expect no failures.

### Task 3: Historical correction and release

**Interfaces:** scoped, guarded D1 cancellation using the existing transaction semantics; no historical Telegram output.

- [x] Back up all current D1 records privately and record counts/hash; verify rollback and cancellation isolation against local D1.
- [x] Cancel exactly 2026-10-16, verify no other logical records changed and no session-local registrations/teams/wins remain.
- [x] Obtain one fresh whole-change code review; address important findings with failing regression tests first.
- [ ] Run full suite/typecheck/build/dry-run, commit and push the production branch, deploy Workers.
- [ ] Verify live health, cron execution, queue/outbox state and production version without fake Telegram posts; report what was not exercised live.
