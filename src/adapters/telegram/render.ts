import type {
  DailyResultsView,
  RegistrationView,
  ScoreView,
  StatusView,
  TeamsView,
} from '../../application/views';
import type { LeaderboardRow } from '../../domain/scoring';
import type { InlineKeyboard } from '../../ports/telegram';

const TEAM_COLORS = ['🟥', '🟦', '🟩', '🟨'] as const;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function russianDate(sessionId: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  }).format(new Date(`${sessionId}T12:00:00.000Z`));
}

function heading(sessionId: string): string {
  return `<b>Пятничный футбол · Пингвин</b>\n📅 ${russianDate(sessionId)} · 21:00\n📍 Манеж «Пингвин»`;
}

function names(rows: readonly { displayName: string }[]): string {
  return rows.length === 0 ? '—' : rows.map((row, index) => `${index + 1}. ${escapeHtml(row.displayName)}`).join('\n');
}

function progressBar(activeCount: number, maxActive: number): string {
  const filled = Math.min(10, Math.max(0, Math.ceil(activeCount / maxActive * 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function teamLabel(teamNumber: 1 | 2 | 3 | 4): string {
  return `${TEAM_COLORS[teamNumber - 1]} Команда ${teamNumber}`;
}

export function renderRegistrationCard(view: RegistrationView): string {
  return [
    heading(view.sessionId),
    '',
    `<b>Запись открыта</b> · ${view.active.length} из ${view.maxActive}`,
    progressBar(view.active.length, view.maxActive),
    '',
    '<b>Основной состав</b>',
    names(view.active),
    '',
    `<b>Общий резерв</b> (${view.waitlist.length})`,
    names(view.waitlist),
  ].join('\n');
}

export function registrationKeyboard(): InlineKeyboard {
  return { inline_keyboard: [
    [{ text: '✅ Иду один', callback_data: 'v1:r:1' }, { text: '👥 Я +1', callback_data: 'v1:r:2' }],
    [{ text: '👥 Я +2', callback_data: 'v1:r:3' }, { text: '❌ Отменить', callback_data: 'v1:r:0' }],
    [{ text: '📋 Состав', callback_data: 'v1:r:list' }],
  ] };
}

export function renderTeams(view: TeamsView): string {
  if (view.teams.length === 0) return `${heading(view.sessionId)}\n\n<b>Недостаточно для двух команд</b>`;
  return [heading(view.sessionId), '', '<b>Составы команд</b>', '', ...view.teams.flatMap((team) => [
    `<b>${teamLabel(team.teamNumber)}</b>`,
    names(team.starters),
    team.reserves.length === 0 ? '' : `<i>Командный резерв:</i> ${names(team.reserves).replaceAll('\n', ', ')}`,
    '',
  ])].join('\n').trimEnd();
}

export function renderReminder(view: RegistrationView): string {
  return `<b>⏰ Напоминание о футболе</b>\n${renderRegistrationCard(view)}`;
}

export function renderPromotion(displayName: string): string {
  return `🎉 ${escapeHtml(displayName)}, вы перешли из резерва в основной состав.`;
}

export function renderScorePanel(view: ScoreView): string {
  const title = view.finished ? '<b>Итоговый счёт</b>' : '<b>Панель счёта</b>';
  const scores = view.teams.length === 0
    ? 'Нет сформированных команд'
    : view.teams.map((team) => `${teamLabel(team.teamNumber)} — <b>${team.wins}</b>`).join('\n');
  return `${heading(view.sessionId)}\n\n${title}\n${scores}`;
}

export function scoreKeyboard(teamNumbers: readonly (1 | 2 | 3 | 4)[]): InlineKeyboard {
  const teamButtons = teamNumbers.map((teamNumber) => ({ text: teamLabel(teamNumber), callback_data: `v1:w:${teamNumber}` }));
  const rows = teamButtons.reduce<Array<Array<{ text: string; callback_data: string }>>>((result, button, index) => {
    if (index % 2 === 0) result.push([button]);
    else result[result.length - 1]!.push(button);
    return result;
  }, []);
  return { inline_keyboard: [
    ...rows,
    [{ text: '↩️ Отменить победу', callback_data: 'v1:w:undo' }],
    [{ text: '🏁 Завершить', callback_data: 'v1:w:finish' }],
  ] };
}

export function finishConfirmationKeyboard(): InlineKeyboard {
  return { inline_keyboard: [[
    { text: '✅ Да, завершить', callback_data: 'v1:w:confirm_finish' },
    { text: '❌ Отмена', callback_data: 'v1:w:undo' },
  ]] };
}

export function renderDailyResults(view: DailyResultsView): string {
  const teams = view.teams.length === 0 ? 'Нет сформированных команд' : view.teams
    .map((team) => `${teamLabel(team.teamNumber)} — ${team.wins}`).join('\n');
  const players = view.rows.length === 0 ? '—' : view.rows
    .map((row) => `${escapeHtml(row.displayName)} — ${row.wins}`).join('\n');
  return `${heading(view.sessionId)}\n\n<b>Итоги вечера</b>\n${teams}\n\n<b>Победы игроков сегодня</b>\n${players}`;
}

export function renderLeaderboard(rows: readonly LeaderboardRow[]): string {
  const rendered = rows.length === 0 ? 'Пока нет завершённых игр.' : rows
    .map((row) => `${row.rank}. ${escapeHtml(row.displayName)} — ${row.wins}`).join('\n');
  return `<b>🏆 Рейтинг · Пятничный футбол · Пингвин</b>\n\n${rendered}`;
}

export function renderStatus(view: StatusView): string {
  const error = view.lastSafeError ? `\nПоследняя ошибка: ${escapeHtml(view.lastSafeError)}` : '';
  return [
    '<b>Статус бота</b>',
    `Сессия: ${view.sessionId} (${view.sessionStatus})`,
    `Следующее действие: ${view.nextActionKind} · ${view.nextActionAtIso}`,
    `Участники: ${view.activeCount}; резерв: ${view.waitlistCount}; команды: ${view.teamCount}`,
    `Ожидающих эффектов: ${view.pendingEffectCount}${error}`,
  ].join('\n');
}
