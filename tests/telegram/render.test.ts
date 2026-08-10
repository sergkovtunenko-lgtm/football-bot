import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  finishConfirmationKeyboard,
  registrationKeyboard,
  renderDailyResults,
  renderLeaderboard,
  renderPromotion,
  renderRegistrationCard,
  renderScorePanel,
  renderStatus,
  renderTeams,
  scoreKeyboard,
} from '../../src/adapters/telegram/render';

describe('Telegram rendering', () => {
  it('escapes all Telegram HTML metacharacters', () => {
    expect(escapeHtml('<Иван & "Ко\'т">')).toBe('&lt;Иван &amp; &quot;Ко&#39;т&quot;&gt;');
  });

  it('renders the approved match-center hierarchy with venue, time, progress, active list, and waitlist', () => {
    const text = renderRegistrationCard({
      sessionId: '2026-07-24',
      active: [{ displayName: '<Иван>' }],
      waitlist: [{ displayName: 'Пётр' }],
      maxActive: 20,
    });
    expect(text).toContain('<b>🏟️⚽ МАТЧ-ЦЕНТР · ПИНГВИН</b>');
    expect(text).toContain('🌆 ПЯТНИЧНЫЙ ФУТБОЛЬНЫЙ ВЕЧЕР');
    expect(text).not.toContain('НОЧЬ');
    expect(text).toContain('Манеж «Пингвин»');
    expect(text).toContain('21:00');
    expect(text).toContain('РЕГИСТРАЦИЯ · 1/20');
    expect(text).toContain('&lt;Иван&gt;');
    expect(text).toContain('🔥 ОСНОВА · 1');
    expect(text).toContain('⏳ РЕЗЕРВ · 1');
  });

  it('explains signup, reserve promotion, random teams, and personal wins in the registration card', () => {
    const view = {
      sessionId: '2026-07-24',
      active: [],
      waitlist: [],
      maxActive: 20,
    } as const;

    const text = renderRegistrationCard(view);
    expect(text).toContain('👥 Записывайтесь кнопками ниже');
    expect(text).toContain('🚦 Первые 20 человек играют');
    expect(text).toContain('🎲 В пятницу в 20:55');
    expect(text).toContain('🏆 победа идёт в личную статистику');
  });

  it('uses versioned compact callback data', () => {
    expect(registrationKeyboard('2026-07-24')).toEqual({ inline_keyboard: [
      [
        { text: '⚽ Иду один', callback_data: 'v2:r:2026-07-24:1', style: 'success' },
        { text: '🤝 Я +1', callback_data: 'v2:r:2026-07-24:2', style: 'primary' },
      ],
      [
        { text: '👥 Я +2', callback_data: 'v2:r:2026-07-24:3', style: 'primary' },
        { text: '🚫 Отменить', callback_data: 'v2:r:2026-07-24:0', style: 'danger' },
      ],
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
    expect(renderRegistrationCard(registration)).toContain('Анна &amp; &lt;Иван&gt;');
    expect(renderPromotion('Оля "Капитан"')).toContain('Оля &quot;Капитан&quot;');
    expect(renderScorePanel({ sessionId: '2026-07-24', teams: [{ teamNumber: 1, wins: 2 }], finished: false })).toContain('2');
    expect(renderDailyResults({
      sessionId: '2026-07-24', teams: [{ teamNumber: 1, wins: 1 }], rows: [{ displayName: "О'Коннор", wins: 1 }],
    })).toContain('О&#39;Коннор');
    expect(renderLeaderboard([{ rank: 1, telegramUserId: '1', displayName: '<Лидер>', wins: 5, evenings: 1 }])).toContain('&lt;Лидер&gt;');
    expect(renderStatus({
      sessionId: '2026-07-24', sessionStatus: 'registration_open', nextActionKind: 'close',
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
