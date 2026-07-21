import { describe, expect, it, vi } from 'vitest';
import { logError, logInfo } from '../src/logger';

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

  it('keeps an Error name and message without leaking hidden secrets', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('deploy failed');
    Object.defineProperty(error, 'authorization', {
      value: 'Bearer must-not-leak',
      enumerable: false,
    });

    logError('deploy', error, { requestId: 'request-123' });

    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: 'deploy',
      error: { name: 'Error', message: 'deploy failed' },
      requestId: 'request-123',
    });
    expect(line).not.toContain('must-not-leak');
  });

  it('redacts sensitive fields nested inside arrays', () => {
    const write = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logInfo('batch', { attempts: [{ authorization: 'Bearer must-not-leak', number: 1 }] });

    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      attempts: [{ authorization: '[REDACTED]', number: 1 }],
    });
    expect(line).not.toContain('must-not-leak');
  });
});
