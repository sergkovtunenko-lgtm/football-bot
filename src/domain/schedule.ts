import { DateTime } from 'luxon';
import type { SessionStatus } from './model';

export type ScheduleActionKind = 'open' | 'close';

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
  const action = actionDueNow(local, sessionId, input.sessionStatus);

  return action && !input.completedActionKeys.has(action.key) ? [action] : [];
}

export function nextScheduleAction(now: Date, status: SessionStatus): NextScheduleAction {
  const local = DateTime.fromJSDate(now, { zone: ZONE });

  if (status === 'registration_open') {
    const close = nextFridayClose(local);
    if (close > local) return { kind: 'close', atIso: toUtcIso(close) };
  }

  return { kind: 'open', atIso: toUtcIso(nextTuesdayAtTen(local)) };
}

function actionDueNow(local: DateTime, sessionId: string, status?: SessionStatus): ScheduleAction | undefined {
  if (status === 'registration_open') {
    if (isFridayCloseDue(local)) return action(sessionId, 'close');
    return undefined;
  }

  if ((!status || status === 'scheduled') && isRegistrationWindow(local)) {
    return action(sessionId, 'open');
  }

  return undefined;
}

function action(sessionId: string, kind: ScheduleActionKind): ScheduleAction {
  return { key: `${sessionId}:${kind}`, sessionId, kind };
}

function isRegistrationWindow(local: DateTime): boolean {
  return local.weekday >= TUESDAY && local.weekday <= FRIDAY
    && atOrAfter(local, 10, 0)
    && !(local.weekday === FRIDAY && atOrAfter(local, 20, 55));
}

function isFridayCloseDue(local: DateTime): boolean {
  return local.weekday === FRIDAY && atOrAfter(local, 20, 55);
}

function atOrAfter(local: DateTime, hour: number, minute: number): boolean {
  return local.hour > hour || (local.hour === hour && local.minute >= minute);
}

function nextFridayClose(local: DateTime): DateTime {
  const daysUntilFriday = (FRIDAY - local.weekday + 7) % 7;
  return at(local.plus({ days: daysUntilFriday }), 20, 55);
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
