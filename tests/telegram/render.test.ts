import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  finishConfirmationKeyboard,
  registrationKeyboard,
  renderDailyResults,
  renderLeaderboard,
  renderPromotion,
  renderRegistrationCard,
  renderReminder,
  renderScorePanel,
  renderStatus,
  renderTeams,
  scoreKeyboard,
} from '../../src/adapters/telegram/render';

describe('Telegram rendering', () => {
  it('escapes all Telegram HTML metacharacters', () => {
    expect(escapeHtml('<Иван & "Ко\'т">')).toBe('&lt;Иван &amp; &quot;Ко&#39;т&quot;&gt;');
  });

  it('shows venue, time, progress, active list, and waitlist', () => {
    const text = renderRegistrationCard({
      sessionId: '2026-07-24',
      active: [{ displayName: '<Иван>' }],
      waitlist: [{ displayName: 'Пётр' }],
      maxActive: 20,
    });
    expect(text).toContain('Манеж «Пингвин»');
    expect(text).toContain('21:00');
    expect(text).toContain('1 из 20');
    expect(text).toContain('&lt;Иван&gt;');
    expect(text).toContain('Общий резерв');
  });

  it('uses versioned compact callback data', () => {
    expect(registrationKeyboard()).toEqual({ inline_keyboard: [
      [{ text: '✅ Иду один', callback_data: 'v1:r:1' }, { text: '👥 Я +1', callback_data: 'v1:r:2' }],
      [{ text: '👥 Я +2', callback_data: 'v1:r:3' }, { text: '❌ Отменить', callback_data: 'v1:r:0' }],
    ] });
  });

  it('renders teams including team reserves and safely handles no teams', () => {
    expect(renderTeams({
      sessionId: '2026-07-24',
      teams: [{ teamNumber: 1, starters: [{ displayName: '<Аня>' }], reserves: [{ displayName: 'Борис & Ко' }] }],
    })).toContain('&lt;Аня&gt;');
    expect(renderTeams({ sessionId: '2026-07-24', teams: [] })).toContain('Недостаточно для двух команд');
  });

  it('renders empty and completed states without placeholder artifacts', () => {
    const teams = renderTeams({
      sessionId: '2026-07-24',
      teams: [{ teamNumber: 1, starters: [], reserves: [] }],
    });
    expect(teams).not.toContain('Командный резерв:');

    const score = renderScorePanel({ sessionId: '2026-07-24', teams: [], finished: true });
    expect(score).toContain('Итоговый счёт');
    expect(score).toContain('Нет сформированных команд');

    const daily = renderDailyResults({ sessionId: '2026-07-24', teams: [], rows: [] });
    expect(daily).toContain('Нет сформированных команд');
    expect(daily).toContain('Победы игроков сегодня</b>\n—');

    expect(renderLeaderboard([])).toContain('Пока нет завершённых игр.');
  });

  it('renders the remaining approved branded views with escaped names', () => {
    const registration = { sessionId: '2026-07-24', active: [{ displayName: 'Анна & <Иван>' }], waitlist: [], maxActive: 20 } as const;
    expect(renderReminder(registration)).toContain('Анна &amp; &lt;Иван&gt;');
    expect(renderPromotion('Оля "Капитан"')).toContain('Оля &quot;Капитан&quot;');
    expect(renderScorePanel({ sessionId: '2026-07-24', teams: [{ teamNumber: 1, wins: 2 }], finished: false })).toContain('2');
    expect(renderDailyResults({
      sessionId: '2026-07-24', teams: [{ teamNumber: 1, wins: 1 }], rows: [{ displayName: "О'Коннор", wins: 1 }],
    })).toContain('О&#39;Коннор');
    expect(renderLeaderboard([{ rank: 1, telegramUserId: '1', displayName: '<Лидер>', wins: 5 }])).toContain('&lt;Лидер&gt;');
    expect(renderStatus({
      sessionId: '2026-07-24', sessionStatus: 'registration_open', nextActionKind: 'reminder',
      nextActionAtIso: '2026-07-23T18:00:00.000Z', activeCount: 0, waitlistCount: 0, teamCount: 0,
      pendingEffectCount: 0, lastSafeError: 'Ошибка & <безопасная>',
    })).toContain('Ошибка &amp; &lt;безопасная&gt;');
  });

  it('uses only compact score callback data for the enabled teams', () => {
    expect(scoreKeyboard([1, 3])).toEqual({ inline_keyboard: [
      [{ text: '🟥 Команда 1', callback_data: 'v1:w:1' }, { text: '🟩 Команда 3', callback_data: 'v1:w:3' }],
      [{ text: '↩️ Отменить победу', callback_data: 'v1:w:undo' }],
      [{ text: '🏁 Завершить', callback_data: 'v1:w:finish' }],
    ] });
    for (const row of scoreKeyboard([1, 2, 3, 4]).inline_keyboard) {
      for (const button of row) expect(Buffer.byteLength(button.callback_data)).toBeLessThan(64);
    }
  });

  it('uses the versioned callback for finish confirmation', () => {
    expect(finishConfirmationKeyboard()).toEqual({ inline_keyboard: [[
      { text: '✅ Да, завершить', callback_data: 'v1:w:confirm_finish' },
      { text: '❌ Отмена', callback_data: 'v1:w:undo' },
    ]] });
  });
});
