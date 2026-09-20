# Admin cancellation and attendance corrections

## Goal

Add administrator-only group controls that (1) cancel the current weekly football session at any state and exclude it from statistics, and (2) correct attendance for exactly one participant after a completed game.

The already approved incomplete-team rule ships in the same release: 1–5 active participants form no teams; 6–20 form groups of five plus a final 1–4-person team; no participant becomes a reserve merely because the final team is incomplete.

## Cancellation

`/cancel` is accepted only from an administrator in the configured group. It targets the current weekly session returned by the existing schedule function; it never selects an arbitrary historical date.

The command displays a group confirmation keyboard. Only an administrator may confirm. Confirmation is idempotent and works whether the current session is absent, open, closed, playing, or finished.

Cancellation leaves a `cancelled` session record so the scheduler cannot open that same date again. In one transaction it removes all session-local participants, teams, team members, win events, win awards, scheduled actions, and queued session effects. It never removes global player profiles or processed Telegram updates. It queues a new `session_cancelled` notice for the configured group. Previously delivered Telegram messages are not deleted or edited by this feature.

Cancelled sessions are excluded from completed-session queries and therefore from attendance and win statistics.

## Attendance correction

`/absent` is accepted only from an administrator in the configured group. It shows buttons for every participant of the latest finished session, including named players and guests. The group can see the panel, but every selection and confirmation is protected by the existing administrator check.

Choosing one participant opens a confirmation keyboard. Confirmation removes only that participant from the finished session; it does not remove the participant's owner, other members of the owner's party, or the global player profile. It removes the participant row, matching team-member row, and only that participant's win-award rows for the session. Team win events and all other participants' attendance and awards stay unchanged.

If no completed session or no selected participant exists, the bot shows a stale-action error and changes nothing.

## Data model and interfaces

- Add `cancelled` to the session-status type and preserve it in YDB.
- Extend the store transaction interface with narrowly scoped methods for cancelling a session and correcting one completed participant.
- Add a `session_cancelled` Telegram outbox effect and renderer.
- Extend update parsing with `/cancel`, `/absent`, versioned cancellation callbacks, and compact attendance-selection callbacks that include the target session and participant id.
- Add confirmation keyboards for cancellation and attendance correction.

## Safety and tests

Tests must cover administrator authorization, confirmation idempotency, cancelling sessions in every status, scheduler non-reopening, statistics exclusion, individual player removal, guest removal, removal of a winner's awards only, stale callbacks, and the complete 1–20 team-formation rule.

No schema migration is required because session status is stored as text. No user profiles, Telegram messages, GitHub data, or Cloudflare Worker code are modified by these controls.
