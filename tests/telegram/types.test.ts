import { describe, expect, it } from 'vitest';
import { telegramId } from '../../src/adapters/telegram/types';

describe('telegramId', () => {
  it('converts safe JSON number identifiers to strings without passing numbers beyond parsing', () => {
    expect(telegramId(9_007_199_254_740_991)).toBe('9007199254740991');
  });

  it('rejects unsafe numeric identifiers instead of rounding them', () => {
    expect(() => telegramId(9_007_199_254_740_992)).toThrow('safe integer');
  });
});
