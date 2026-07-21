import { describe, expect, it } from 'vitest';
import {
  dueScheduleActions,
  nextScheduleAction,
  sessionIdForCurrentCycle,
} from '../../src/domain/schedule';

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

  it('keeps a current-day reminder due through the Moscow 12:00 minute only', () => {
    expect(due('2026-07-22T09:00:00Z', [], 'registration_open')).toMatchObject([
      { key: '2026-07-24:reminder:wed', kind: 'reminder' },
    ]);
    expect(due('2026-07-22T09:01:00Z', [], 'registration_open')).toEqual([]);
  });

  it('does not act on Monday at 23:59 Moscow', () => {
    expect(due('2026-07-20T20:59:00Z')).toEqual([]);
  });

  it('catches up the Tuesday opening without duplicating it', () => {
    const action = due('2026-07-21T09:00:00Z')[0]!;
    expect(action).toMatchObject({ key: '2026-07-24:open', kind: 'open' });
    expect(due('2026-07-21T09:00:30Z', [action.key])).toEqual([]);
  });

  it('reminds at Friday 10:00 and closes at Friday 20:55', () => {
    expect(due('2026-07-24T07:00:00Z', [], 'registration_open')).toMatchObject([
      { key: '2026-07-24:reminder:fri', kind: 'reminder' },
    ]);
    expect(due('2026-07-24T17:55:00Z', [], 'registration_open')).toMatchObject([
      { key: '2026-07-24:close', kind: 'close' },
    ]);
  });

  it('does not act on Saturday', () => {
    expect(due('2026-07-25T09:00:00Z', [], 'registration_open')).toEqual([]);
  });

  it('does not repeat a completed opening action', () => {
    expect(due('2026-07-21T07:00:00Z', ['2026-07-24:open'])).toEqual([]);
  });

  it('does not schedule actions for a finished session', () => {
    expect(due('2026-07-23T08:00:00Z', [], 'finished')).toEqual([]);
  });

  it('uses the same stable key for repeated calls in one minute', () => {
    expect(due('2026-07-23T08:00:00Z', [], 'registration_open')).toEqual(
      due('2026-07-23T08:00:59Z', [], 'registration_open'),
    );
  });

  it('reports the next Tuesday opening in UTC', () => {
    expect(nextScheduleAction(new Date('2026-07-20T20:59:00Z'), 'scheduled')).toEqual({
      kind: 'open',
      atIso: '2026-07-21T07:00:00.000Z',
    });
  });

  it('reports the next daily reminder while registration is open', () => {
    expect(nextScheduleAction(new Date('2026-07-22T06:59:59Z'), 'registration_open')).toEqual({
      kind: 'reminder',
      atIso: '2026-07-22T07:00:00.000Z',
    });
  });

  it('reports Friday close while registration is open', () => {
    expect(nextScheduleAction(new Date('2026-07-24T10:00:00Z'), 'registration_open')).toEqual({
      kind: 'close',
      atIso: '2026-07-24T17:55:00.000Z',
    });
  });

  it('reports the next Tuesday opening after finish', () => {
    expect(nextScheduleAction(new Date('2026-07-24T18:00:00Z'), 'finished')).toEqual({
      kind: 'open',
      atIso: '2026-07-28T07:00:00.000Z',
    });
  });
});
