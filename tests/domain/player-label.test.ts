import { describe, expect, it } from 'vitest';
import { playerLabel } from '../../src/domain/player-label';

describe('playerLabel', () => {
  it('prefers and trims the Telegram name without appending username', () => {
    expect(playerLabel({ displayName: '  Сергей Ковтуненко  ', username: 'sergey' }))
      .toBe('Сергей Ковтуненко');
  });

  it('uses one leading @ when the name is blank', () => {
    expect(playerLabel({ displayName: ' ', username: 'football_player' })).toBe('@football_player');
    expect(playerLabel({ displayName: '', username: '@football_player' })).toBe('@football_player');
  });

  it('uses a historical name before the neutral fallback', () => {
    expect(playerLabel({}, '  Старое имя  ')).toBe('Старое имя');
    expect(playerLabel({ displayName: ' ', username: ' ' }, ' ')).toBe('Игрок');
  });
});
