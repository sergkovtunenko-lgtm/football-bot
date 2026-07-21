import type { Clock } from '../ports/clock';
import type { RandomSource } from '../ports/random';
import type { FootballStore } from '../ports/store';
import type { Session } from '../domain/model';
import { dueScheduleActions, sessionIdForCurrentCycle } from '../domain/schedule';
import { closeSession } from './bot-service';

export class Scheduler {
  constructor(
    private readonly store: FootballStore,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly newId: () => string,
  ) {}

  async tick(): Promise<void> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const sessionId = sessionIdForCurrentCycle(now);
    await this.store.transact(async (tx) => {
      const session = await tx.getSession(sessionId);
      const actions = dueScheduleActions(session
        ? { now, completedActionKeys: new Set(), sessionStatus: session.status }
        : { now, completedActionKeys: new Set() });
      for (const action of actions) {
        if (await tx.hasScheduledAction(action.key)) continue;
        if (action.kind === 'open') {
          const opened: Session = {
            sessionId: action.sessionId,
            status: 'registration_open',
            nextQueuePosition: 1n,
            nextWinOrdinal: 1n,
          };
          await tx.saveSession(opened);
          await tx.enqueue(this.newId(), { kind: 'registration_card', sessionId: action.sessionId }, nowIso);
        } else if (action.kind === 'reminder') {
          if (session?.status === 'registration_open') {
            await tx.enqueue(this.newId(), {
              kind: 'reminder',
              sessionId: action.sessionId,
              actionKey: action.key,
            }, nowIso);
          }
        } else {
          await closeSession(tx, action.sessionId, nowIso, this.random, this.newId);
        }
        await tx.markScheduledAction(action.key, action.sessionId, action.kind, nowIso);
      }
    });
  }
}
