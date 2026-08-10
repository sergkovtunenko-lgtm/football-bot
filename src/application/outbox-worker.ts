import type { Clock } from '../ports/clock';
import type { FootballStore, FootballTransaction, StoredEffect, TelegramEffect } from '../ports/store';
import { TelegramError, type InlineKeyboard, type TelegramPort } from '../ports/telegram';
import {
  escapeHtml,
  registrationKeyboard,
  renderDailyResults,
  renderLeaderboard,
  renderPromotion,
  renderRegistrationCard,
  renderScorePanel,
  renderTeams,
  scoreKeyboard,
} from '../adapters/telegram/render';
import { buildLeaderboard, dailyPlayerWins } from '../domain/scoring';
import type { Session, TeamMember, WinEvent } from '../domain/model';
import { playerLabel } from '../domain/player-label';
import { logError } from '../logger';
import type { DailyResultsView, RegistrationView, ScoreView, TeamsView } from './views';
import { redactTelegramTokens } from '../security/redact';

const MAX_FLUSH_LIMIT = 10;
const SAFE_ERROR_LIMIT = 500;
const BACKOFF_SECONDS = [30, 120, 600, 3600] as const;

type MessageSlot = 'registrationMessageId' | 'scoreMessageId';

interface PreparedMessage {
  html: string;
  keyboard?: InlineKeyboard;
  existingMessageId?: string;
  messageSlot?: MessageSlot;
  pinWhenCreated?: boolean;
}

interface PreparedEffect {
  chatId: string;
  sessionId?: string;
  messages: readonly PreparedMessage[];
}

export class OutboxWorker {
  constructor(
    private readonly store: FootballStore,
    private readonly telegram: TelegramPort,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async flush(limit = MAX_FLUSH_LIMIT): Promise<{ sent: number; rescheduled: number }> {
    const count = Math.min(MAX_FLUSH_LIMIT, Math.max(0, Math.trunc(limit)));
    let sent = 0;
    let rescheduled = 0;
    for (let index = 0; index < count; index += 1) {
      const nowIso = this.clock.now().toISOString();
      const [effect] = await this.store.claimDueEffects(nowIso, 1, this.newId());
      if (!effect) break;
      const outcome = await this.process(effect);
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'rescheduled') rescheduled += 1;
    }
    return { sent, rescheduled };
  }

  private async process(stored: StoredEffect): Promise<'sent' | 'rescheduled' | 'failed'> {
    let pin: { chatId: string; messageId: string } | undefined;
    try {
      const prepared = await this.prepare(stored.effect);
      for (const message of prepared.messages) {
        if (message.existingMessageId !== undefined) {
          try {
            if (message.keyboard === undefined) {
              await this.telegram.editMessage(prepared.chatId, message.existingMessageId, message.html);
            } else {
              await this.telegram.editMessage(prepared.chatId, message.existingMessageId, message.html, message.keyboard);
            }
          } catch (error) {
            if (!isMessageNotModified(error)) throw error;
          }
          continue;
        }
        const created = message.keyboard === undefined
          ? await this.telegram.sendMessage(prepared.chatId, message.html)
          : await this.telegram.sendMessage(prepared.chatId, message.html, message.keyboard);
        if (message.messageSlot !== undefined && prepared.sessionId !== undefined) {
          await this.persistMessageId(prepared.sessionId, message.messageSlot, created.messageId);
        }
        if (message.pinWhenCreated === true) pin = { chatId: prepared.chatId, messageId: created.messageId };
      }
      await this.store.markEffectSent(stored.effectId, this.clock.now().toISOString());
    } catch (error) {
      return this.handleFailure(stored, error);
    }

    if (pin) {
      try {
        await this.telegram.pinMessage(pin.chatId, pin.messageId);
      } catch (error) {
        logError('telegram_pin_failed', new Error(safeError(error)), { effectId: stored.effectId });
      }
    }
    return 'sent';
  }

  private async handleFailure(stored: StoredEffect, error: unknown): Promise<'rescheduled' | 'failed'> {
    const now = this.clock.now();
    const errorText = safeError(error);
    if (isPermanentTelegramFailure(error)) {
      await this.store.markEffectPermanentlyFailed(stored.effectId, now.toISOString(), errorText);
      return 'failed';
    }

    const attempts = stored.attempts + 1;
    const retryAfter = telegramRetryAfterSeconds(error);
    const backoff = BACKOFF_SECONDS[Math.min(stored.attempts, BACKOFF_SECONDS.length - 1)]!;
    const delaySeconds = Math.max(backoff, retryAfter ?? 0);
    if (attempts === 4 && stored.effect.kind !== 'admin_error') {
      await this.store.rescheduleEffectWithNotice(
        stored.effectId,
        attempts,
        new Date(now.getTime() + delaySeconds * 1000).toISOString(),
        errorText,
        `admin-error:${stored.effectId}`,
        {
          kind: 'admin_error',
          correlationId: stored.effectId,
          summary: 'Не удалось доставить служебное сообщение после нескольких попыток.',
        },
        now.toISOString(),
      );
      return 'rescheduled';
    }
    await this.store.rescheduleEffect(
      stored.effectId,
      attempts,
      new Date(now.getTime() + delaySeconds * 1000).toISOString(),
      errorText,
    );
    return 'rescheduled';
  }

  private prepare(effect: TelegramEffect): Promise<PreparedEffect> {
    return this.store.transact(async (tx) => {
      const { groupChatId } = await tx.getSettings();
      if (!groupChatId) throw new Error('Telegram group is not configured');
      switch (effect.kind) {
        case 'registration_card': {
          const session = await requireSession(tx, effect.sessionId);
          const view = await registrationView(tx, effect.sessionId);
          return {
            chatId: groupChatId,
            sessionId: effect.sessionId,
            messages: [{
              html: renderRegistrationCard(view),
              keyboard: registrationKeyboard(view.sessionId),
              ...(session.registrationMessageId === undefined ? {
                messageSlot: 'registrationMessageId' as const, pinWhenCreated: true,
              } : { existingMessageId: session.registrationMessageId }),
            }],
          };
        }
        case 'promotion_notice': {
          const participants = await tx.listParticipants(effect.sessionId);
          const displayName = participants.find((participant) => participant.ownerUserId === effect.ownerUserId)?.displayName
            ?? 'Игрок';
          return { chatId: groupChatId, messages: [{ html: renderPromotion(displayName) }] };
        }
        case 'teams': {
          const view = await teamsView(tx, effect.sessionId);
          const participants = await tx.listParticipants(effect.sessionId);
          const html = view.teams.length === 0
            ? `${renderTeams(view)}\nУчастников: ${participants.length}`
            : renderTeams(view);
          return { chatId: groupChatId, messages: [{ html }] };
        }
        case 'score_panel': {
          const session = await requireSession(tx, effect.sessionId);
          const view = await scoreView(tx, session);
          return {
            chatId: groupChatId,
            sessionId: effect.sessionId,
            messages: [{
              html: renderScorePanel(view),
              keyboard: scoreKeyboard(view.teams.map((team) => team.teamNumber)),
              ...(session.scoreMessageId === undefined ? {
                messageSlot: 'scoreMessageId' as const, pinWhenCreated: true,
              } : { existingMessageId: session.scoreMessageId }),
            }],
          };
        }
        case 'final_results': {
          const { daily, leaderboard } = await finalViews(tx, effect.sessionId);
          return { chatId: groupChatId, messages: [
            { html: renderDailyResults(daily) },
            { html: renderLeaderboard(leaderboard) },
          ] };
        }
        case 'admin_error':
          return {
            chatId: groupChatId,
            messages: [{ html: `⚠️ Не удалось доставить служебное сообщение. Код: <code>${escapeHtml(effect.correlationId)}</code>` }],
          };
      }
    });
  }

  private async persistMessageId(sessionId: string, slot: MessageSlot, messageId: string): Promise<void> {
    await this.store.transact(async (tx) => {
      const session = await requireSession(tx, sessionId);
      await tx.saveSession({ ...session, [slot]: messageId });
    });
  }
}

async function requireSession(tx: FootballTransaction, sessionId: string): Promise<Session> {
  const session = await tx.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

async function registrationView(tx: FootballTransaction, sessionId: string): Promise<RegistrationView> {
  const participants = (await tx.listParticipants(sessionId))
    .sort((a, b) => a.queuePosition < b.queuePosition ? -1 : a.queuePosition > b.queuePosition ? 1 : 0);
  return {
    sessionId,
    active: participants.filter((participant) => participant.rosterStatus === 'active')
      .map(({ displayName }) => ({ displayName })),
    waitlist: participants.filter((participant) => participant.rosterStatus === 'waitlist')
      .map(({ displayName }) => ({ displayName })),
    maxActive: 20,
  };
}

async function teamsView(tx: FootballTransaction, sessionId: string): Promise<TeamsView> {
  const teams = await tx.listTeams(sessionId);
  const members = await tx.listTeamMembers(sessionId);
  return {
    sessionId,
    teams: teams.map((team) => ({
      teamNumber: team.teamNumber,
      starters: members.filter((member) => member.teamNumber === team.teamNumber && member.role === 'starter')
        .map(({ displayName }) => ({ displayName })),
      reserves: members.filter((member) => member.teamNumber === team.teamNumber && member.role === 'reserve')
        .map(({ displayName }) => ({ displayName })),
    })),
  };
}

async function scoreView(tx: FootballTransaction, session: Session): Promise<ScoreView> {
  const teams = await tx.listTeams(session.sessionId);
  const events = await tx.listWinEvents(session.sessionId);
  return {
    sessionId: session.sessionId,
    teams: teams.map((team) => ({
      teamNumber: team.teamNumber,
      wins: activeWins(events, team.teamNumber),
    })),
    finished: session.status === 'finished',
  };
}

async function finalViews(tx: FootballTransaction, sessionId: string) {
  const teams = await tx.listTeams(sessionId);
  const events = await tx.listWinEvents();
  const awards = await tx.listWinAwards();
  const completedSessionIds = await tx.listCompletedSessionIds();
  const players = await tx.listPlayers();
  const wins = dailyPlayerWins(sessionId, events, awards);
  const profiles = new Map(players.map((player) => [player.telegramUserId, player]));
  const historicalNames = new Map(awards.map((award) => [award.telegramUserId, award.displayName]));
  const members: TeamMember[] = [];
  for (const completedSessionId of completedSessionIds) {
    members.push(...await tx.listTeamMembers(completedSessionId));
  }
  const daily: DailyResultsView = {
    sessionId,
    teams: teams.map((team) => ({ teamNumber: team.teamNumber, wins: activeWins(events, team.teamNumber, sessionId) })),
    rows: [...wins].map(([telegramUserId, count]) => ({
      displayName: playerLabel(profiles.get(telegramUserId) ?? {}, historicalNames.get(telegramUserId)),
      wins: count,
    })).sort((a, b) => b.wins - a.wins || a.displayName.localeCompare(b.displayName, 'ru')),
  };
  return {
    daily,
    leaderboard: buildLeaderboard(events, awards, completedSessionIds, members, profiles),
  };
}

function activeWins(events: readonly WinEvent[], teamNumber: 1 | 2 | 3 | 4, sessionId?: string): number {
  return events.filter((event) => event.teamNumber === teamNumber
    && (sessionId === undefined || event.sessionId === sessionId)
    && event.reversedAtIso === undefined).length;
}

function isMessageNotModified(error: unknown): boolean {
  return error instanceof TelegramError
    && error.status === 400
    && error.description.toLowerCase().includes('message is not modified');
}

function isPermanentTelegramFailure(error: unknown): boolean {
  return error instanceof TelegramError
    && error.status !== undefined
    && error.status >= 400
    && error.status < 500
    && error.status !== 429;
}

function telegramRetryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof TelegramError) || error.status !== 429) return undefined;
  const property = error.retryAfterSeconds;
  if (typeof property === 'number' && Number.isFinite(property) && property >= 0) return property;
  const match = /retry after\s+(\d+)/i.exec(error.description);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactTelegramTokens(raw).slice(0, SAFE_ERROR_LIMIT);
}
