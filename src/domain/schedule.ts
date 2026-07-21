import { DateTime } from 'luxon';
import type { SessionStatus } from './model';

export type ScheduleActionKind = 'open' | 'reminder' | 'close';

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
    const nextWhileOpen = nextActionWhileOpen(local);
    if (nextWhileOpen) return nextWhileOpen;
  }

  return { kind: 'open', atIso: toUtcIso(nextTuesdayAtTen(local)) };
}

function actionDueNow(local: DateTime, sessionId: string, status?: SessionStatus): ScheduleAction | undefined {
  if (status === 'registration_open') {
    if (isFridayCloseDue(local)) return action(sessionId, 'close');
    if (isReminderDue(local)) return action(sessionId, 'reminder', reminderDay(local));
    return undefined;
  }

  if ((!status || status === 'scheduled') && isRegistrationWindow(local)) {
    return action(sessionId, 'open');
  }

  return undefined;
}

function action(sessionId: string, kind: ScheduleActionKind, day?: string): ScheduleAction {
  const suffix = kind === 'reminder' ? `:${day!}` : '';
  return { key: `${sessionId}:${kind}${suffix}`, sessionId, kind };
}

function isRegistrationWindow(local: DateTime): boolean {
  return local.weekday >= TUESDAY && local.weekday <= FRIDAY
    && atOrAfter(local, 10, 0)
    && !(local.weekday === FRIDAY && atOrAfter(local, 20, 55));
}

function isReminderDue(local: DateTime): boolean {
  return local.weekday >= TUESDAY + 1
    && local.weekday <= FRIDAY
    && atOrAfter(local, 10, 0)
    && !atOrAfter(local, 12, 1);
}

function isFridayCloseDue(local: DateTime): boolean {
  return local.weekday === FRIDAY && atOrAfter(local, 20, 55);
}

function reminderDay(local: DateTime): string {
  return ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][local.weekday - 1]!;
}

function atOrAfter(local: DateTime, hour: number, minute: number): boolean {
  return local.hour > hour || (local.hour === hour && local.minute >= minute);
}

function nextActionWhileOpen(local: DateTime): NextScheduleAction | undefined {
  if (local.weekday >= TUESDAY + 1 && local.weekday <= FRIDAY) {
    const reminderToday = at(local, 10, 0);
    if (reminderToday > local) return { kind: 'reminder', atIso: toUtcIso(reminderToday) };

    if (local.weekday < FRIDAY) {
      return { kind: 'reminder', atIso: toUtcIso(at(local.plus({ days: 1 }), 10, 0)) };
    }

    const closeToday = at(local, 20, 55);
    if (closeToday > local) return { kind: 'close', atIso: toUtcIso(closeToday) };
  }

  if (local.weekday === FRIDAY) return undefined;
  return { kind: 'reminder', atIso: toUtcIso(nextWednesdayAtTen(local)) };
}

function nextTuesdayAtTen(local: DateTime): DateTime {
  return nextWeekdayAtTen(local, TUESDAY);
}

function nextWednesdayAtTen(local: DateTime): DateTime {
  return nextWeekdayAtTen(local, TUESDAY + 1);
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
