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
const TELEGRAM_MESSAGE_LIMIT = 4096;
const LEADERBOARD_BODY_LIMIT = 3900;
const LEADERBOARD_NAME_LIMIT = 128;

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

function leaderboardEntry(row: LeaderboardRow): string {
  const name = escapeHtml(row.displayName.slice(0, LEADERBOARD_NAME_LIMIT));
  return [
    `${rankMarker(row.rank)} ${name}`,
    `   🏆 ${row.wins} ${russianCount(row.wins, 'победа', 'победы', 'побед')} · `
      + `📅 ${row.evenings} ${russianCount(row.evenings, 'вечер', 'вечера', 'вечеров')}`,
  ].join('\n');
}

export function renderRegistrationCard(view: RegistrationView): string {
  return [
    '<b>🏟️⚽ МАТЧ-ЦЕНТР · ПИНГВИН</b>',
    '<i>🌆 ПЯТНИЧНЫЙ ФУТБОЛЬНЫЙ ВЕЧЕР</i>',
    `📅 ${russianDate(view.sessionId)} · <b>21:00</b>`,
    '📍 Манеж «Пингвин»',
    '',
    '<b>📋 РЕГЛАМЕНТ</b>',
    '👥 Записывайтесь кнопками ниже: один, с другом или втроём; если планы изменились — нажмите «Отменить».',
    '🚦 Первые 20 человек играют, остальные ждут в резерве и автоматически поднимаются, когда освобождается место.',
    '🎲 В пятницу в 20:55 бот закрывает запись и случайным образом формирует команды.',
    '⏱️ Играем до 5 минут или 2 голов, а 🏆 победа идёт в личную статистику каждого игрока команды.',
    '',
    `<b>🟢 РЕГИСТРАЦИЯ · ${view.active.length}/${view.maxActive}</b>`,
    progressBar(view.active.length, view.maxActive),
    '',
    `<b>🔥 ОСНОВА · ${view.active.length}</b>`,
    names(view.active),
    '',
    `<b>⏳ РЕЗЕРВ · ${view.waitlist.length}</b>`,
    names(view.waitlist),
  ].join('\n');
}

export function registrationKeyboard(sessionId: string): InlineKeyboard {
  return { inline_keyboard: [
    [
      { text: '⚽ Иду один', callback_data: `v2:r:${sessionId}:1`, style: 'success' },
      { text: '🤝 Я +1', callback_data: `v2:r:${sessionId}:2`, style: 'primary' },
    ],
    [
      { text: '👥 Я +2', callback_data: `v2:r:${sessionId}:3`, style: 'primary' },
      { text: '🚫 Отменить', callback_data: `v2:r:${sessionId}:0`, style: 'danger' },
    ],
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

export function renderLeaderboardPages(rows: readonly LeaderboardRow[]): readonly string[] {
  const entries = rows.length === 0
    ? ['Пока нет завершённых футбольных вечеров.']
    : rows.map(leaderboardEntry);
  const bodies: string[] = [];
  let body = '';
  for (const entry of entries) {
    const candidate = body === '' ? entry : `${body}\n\n${entry}`;
    if (body !== '' && candidate.length > LEADERBOARD_BODY_LIMIT) {
      bodies.push(body);
      body = entry;
    } else {
      body = candidate;
    }
  }
  bodies.push(body);
  const pages = bodies.map((currentBody, index) => {
    const suffix = bodies.length === 1 ? '' : ` · ${index + 1}/${bodies.length}`;
    return `<b>🏆 РЕЙТИНГ СЕЗОНА${suffix}</b>\n\n${currentBody}`;
  });
  if (pages.some((page) => page.length > TELEGRAM_MESSAGE_LIMIT)) {
    throw new Error('Rendered leaderboard exceeds Telegram message limit');
  }
  return pages;
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
