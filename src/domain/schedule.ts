import { DateTime } from 'luxon';
import type { SessionStatus } from './model';

export type ScheduleActionKind = 'open' | 'close' | 'teams';

export interface ScheduleAction {
  key: string;
  sessionId: string;
  kind: ScheduleActionKind;
}

export interface ScheduleInput {
  now: Date;
  completedActionKeys: ReadonlySet<string>;
  sessionStatus?: SessionStatus;
}

export interface NextScheduleAction {
  kind: ScheduleActionKind;
  atIso: string;
}

const ZONE = 'Europe/Moscow';
const TUESDAY = 2;
const FRIDAY = 5;

export function sessionIdForCurrentCycle(now: Date): string {
  const local = DateTime.fromJSDate(now, { zone: ZONE });
  const daysUntilFriday = (FRIDAY - local.weekday + 7) % 7;
  return local.plus({ days: daysUntilFriday }).toISODate()!;
}

export function dueScheduleActions(input: ScheduleInput): ScheduleAction[] {
  const local = DateTime.fromJSDate(input.now, { zone: ZONE });
  const sessionId = sessionIdForCurrentCycle(input.now);
  const actions: ScheduleAction[] = [];
  if (input.sessionStatus === 'registration_open' && isFridayCloseDue(local)) {
    actions.push(action(sessionId, 'close'));
  }
  if (['registration_open', 'registration_closed'].includes(input.sessionStatus ?? '')
    && local.weekday === FRIDAY && atOrAfter(local, 20, 55)) {
    actions.push(action(sessionId, 'teams'));
  }
  if ((!input.sessionStatus || input.sessionStatus === 'scheduled') && isRegistrationWindow(local)) {
    actions.push(action(sessionId, 'open'));
  }

  return actions.filter((candidate) => !input.completedActionKeys.has(candidate.key));
}

export function nextScheduleAction(now: Date, status: SessionStatus): NextScheduleAction {
  const local = DateTime.fromJSDate(now, { zone: ZONE });

  if (status === 'registration_open') {
    const close = nextFridayClose(local);
    return { kind: 'close', atIso: toUtcIso(close) };
  }
  if (status === 'registration_closed') {
    const teams = nextFridayClose(local).set({ hour: 20, minute: 55 });
    return { kind: 'teams', atIso: toUtcIso(teams) };
  }

  return { kind: 'open', atIso: toUtcIso(nextTuesdayAtTen(local)) };
}

function action(sessionId: string, kind: ScheduleActionKind): ScheduleAction {
  return { key: `${sessionId}:${kind}`, sessionId, kind };
}

function isRegistrationWindow(local: DateTime): boolean {
  return local.weekday >= TUESDAY && local.weekday <= FRIDAY
    && atOrAfter(local, 10, 0)
    && !isFridayCloseDue(local);
}

function isFridayCloseDue(local: DateTime): boolean {
  return local.weekday === FRIDAY && atOrAfter(local, 19, 0);
}

function atOrAfter(local: DateTime, hour: number, minute: number): boolean {
  return local.hour > hour || (local.hour === hour && local.minute >= minute);
}

function nextFridayClose(local: DateTime): DateTime {
  const daysUntilFriday = (FRIDAY - local.weekday + 7) % 7;
  return at(local.plus({ days: daysUntilFriday }), 19, 0);
}

function nextTuesdayAtTen(local: DateTime): DateTime {
  return nextWeekdayAtTen(local, TUESDAY);
}

function nextWeekdayAtTen(local: DateTime, weekday: number): DateTime {
  const daysUntilWeekday = (weekday - local.weekday + 7) % 7;
  const candidate = at(local.plus({ days: daysUntilWeekday }), 10, 0);
  return candidate > local ? candidate : candidate.plus({ days: 7 });
}

function at(local: DateTime, hour: number, minute: number): DateTime {
  return local.startOf('day').set({ hour, minute });
}

function toUtcIso(local: DateTime): string {
  return local.toUTC().toISO()!;
}
