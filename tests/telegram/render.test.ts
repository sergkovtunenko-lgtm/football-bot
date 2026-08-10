import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  finishConfirmationKeyboard,
  registrationKeyboard,
  renderDailyResults,
  renderLeaderboardPages,
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

    expect(renderLeaderboardPages([])).toEqual([
      expect.stringContaining('Пока нет завершённых футбольных вечеров.'),
    ]);
  });

  it('renders the remaining approved branded views with escaped names', () => {
    const registration = { sessionId: '2026-07-24', active: [{ displayName: 'Анна & <Иван>' }], waitlist: [], maxActive: 20 } as const;
    expect(renderRegistrationCard(registration)).toContain('Анна &amp; &lt;Иван&gt;');
    expect(renderPromotion('Оля "Капитан"')).toContain('Оля &quot;Капитан&quot;');
    expect(renderScorePanel({ sessionId: '2026-07-24', teams: [{ teamNumber: 1, wins: 2 }], finished: false })).toContain('2');
    expect(renderDailyResults({
      sessionId: '2026-07-24', teams: [{ teamNumber: 1, wins: 1 }], rows: [{ displayName: "О'Коннор", wins: 1 }],
    })).toContain('О&#39;Коннор');
    expect(renderLeaderboardPages([
      { rank: 1, telegramUserId: '1', displayName: '<Лидер>', wins: 5, evenings: 1 },
    ]).join('\n')).toContain('&lt;Лидер&gt;');
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

  it('renders the approved two-line season rating with medals and Russian word forms', () => {
    const [rating] = renderLeaderboardPages([
      { rank: 1, telegramUserId: '1', displayName: '<Сергей>', wins: 12, evenings: 3 },
      { rank: 1, telegramUserId: '2', displayName: 'Вячеслав', wins: 1, evenings: 1 },
      { rank: 3, telegramUserId: '3', displayName: '@football_player', wins: 0, evenings: 5 },
      { rank: 4, telegramUserId: '4', displayName: 'Игрок 4', wins: 2, evenings: 2 },
      { rank: 5, telegramUserId: '5', displayName: 'Игрок 5', wins: 5, evenings: 11 },
      { rank: 6, telegramUserId: '6', displayName: 'Игрок 6', wins: 21, evenings: 21 },
    ]);

    expect(rating).toContain('<b>🏆 РЕЙТИНГ СЕЗОНА</b>');
    expect(rating).toContain('🥇 &lt;Сергей&gt;\n   🏆 12 побед · 📅 3 вечера');
    expect(rating).toContain('🥇 Вячеслав\n   🏆 1 победа · 📅 1 вечер');
    expect(rating).toContain('🥉 @football_player\n   🏆 0 побед · 📅 5 вечеров');
    expect(rating).toContain('4. Игрок 4\n   🏆 2 победы · 📅 2 вечера');
    expect(rating).toContain('5. Игрок 5\n   🏆 5 побед · 📅 11 вечеров');
    expect(rating).toContain('6. Игрок 6\n   🏆 21 победа · 📅 21 вечер');
  });

  it('splits a long rating into complete Telegram-safe pages without losing players', () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      rank: index + 1,
      telegramUserId: String(index + 1),
      displayName: `Игрок-${String(index + 1).padStart(3, '0')}-${'А'.repeat(72)}`,
      wins: 120 - index,
      evenings: 12,
    }));

    const pages = renderLeaderboardPages(rows);
    const rendered = pages.join('\n');
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 4096)).toBe(true);
    expect(pages[0]).toMatch(/РЕЙТИНГ СЕЗОНА · 1\/\d+/);
    expect(pages.at(-1)).toContain(`· ${pages.length}/${pages.length}`);
    for (const row of rows) expect(rendered).toContain(row.displayName);
  });

  it('uses the versioned callback for finish confirmation', () => {
    expect(finishConfirmationKeyboard()).toEqual({ inline_keyboard: [[
      { text: '✅ Да, завершить', callback_data: 'v1:w:confirm_finish' },
      { text: '❌ Отмена', callback_data: 'v1:w:undo' },
    ]] });
  });
});
