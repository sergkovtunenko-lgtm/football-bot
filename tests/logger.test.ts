import { describe, expect, it, vi } from 'vitest';
import { logInfo } from '../src/logger';

describe('structured logger', () => {
  it('recursively redacts secrets before writing one JSON line', () => {
    const write = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logInfo('deploy', {
      botToken: '123456:must-not-leak',
      nested: { authorization: 'Bearer must-not-leak', attempt: 2 },
    });
    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: 'deploy',
      botToken: '[REDACTED]',
      nested: { authorization: '[REDACTED]', attempt: 2 },
    });
    expect(line).not.toContain('must-not-leak');
  });
});
