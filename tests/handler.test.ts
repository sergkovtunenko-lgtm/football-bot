import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler, createRetryAfterPreservingFetcher } from '../src/handler';

const SECRET = 'telegram_secret_123';

function fixture() {
  return {
    webhookSecret: SECRET,
    router: { handle: vi.fn().mockResolvedValue(undefined) },
    scheduler: { tick: vi.fn().mockResolvedValue(undefined) },
    outbox: { flush: vi.fn().mockResolvedValue({ sent: 0, rescheduled: 0 }) },
    newCorrelationId: vi.fn(() => 'corr-123'),
  };
}

function http(overrides: Record<string, unknown> = {}) {
  return {
    httpMethod: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
    body: JSON.stringify({ update_id: 77 }),
    ...overrides,
  };
}

function timer() {
  return { messages: [{ event_metadata: {
    event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage',
    event_id: 'timer-1',
    created_at: '2026-07-21T07:00:00Z',
  }, details: { trigger_id: 'trigger-1', payload: 'tick' } }] };
}

afterEach(() => vi.restoreAllMocks());

describe('createHandler HTTP security', () => {
  it('rejects an invalid Telegram secret before parsing the body', async () => {
    const deps = fixture();
    const response = await createHandler(deps)({
      httpMethod: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: '{bad-json',
    }, {} as never);
    expect(response).toMatchObject({ statusCode: 403 });
    expect(deps.router.handle).not.toHaveBeenCalled();
  });

  it('accepts valid secret and a JSON string body, then flushes', async () => {
    const deps = fixture();
    const response = await createHandler(deps)(http(), {} as never);
    expect(response).toMatchObject({ statusCode: 200 });
    expect(deps.router.handle).toHaveBeenCalledWith({ update_id: 77 });
    expect(deps.outbox.flush).toHaveBeenCalledWith(10);
  });

  it('accepts a Yandex-supplied object body', async () => {
    const deps = fixture();
    const response = await createHandler(deps)(http({ body: { update_id: 78 } }), {} as never);
    expect(response).toMatchObject({ statusCode: 200 });
    expect(deps.router.handle).toHaveBeenCalledWith({ update_id: 78 });
  });

  it('returns 400 for invalid JSON after accepting the secret', async () => {
    const deps = fixture();
    const response = await createHandler(deps)(http({ body: '{bad-json' }), {} as never);
    expect(response).toMatchObject({ statusCode: 400 });
    expect(deps.router.handle).not.toHaveBeenCalled();
  });

  it('returns 405 for methods other than POST', async () => {
    const deps = fixture();
    const response = await createHandler(deps)(http({ httpMethod: 'GET' }), {} as never);
    expect(response).toMatchObject({ statusCode: 405, headers: { allow: 'POST' } });
    expect(deps.router.handle).not.toHaveBeenCalled();
  });

  it('returns 413 for a body larger than 1 MiB without parsing it', async () => {
    const deps = fixture();
    const response = await createHandler(deps)(http({ body: `"${'x'.repeat(1024 * 1024)}"` }), {} as never);
    expect(response).toMatchObject({ statusCode: 413 });
    expect(deps.router.handle).not.toHaveBeenCalled();
  });

  it.each([
    ['same-length mismatch', 'telegram_secret_124'],
    ['short prefix', 'telegram_secret'],
    ['long suffix', `${SECRET}x`],
    ['missing', undefined],
  ])('accepts only an exactly equal secret: %s', async (_name, supplied) => {
    const deps = fixture();
    const headers = supplied === undefined ? {} : { 'x-telegram-bot-api-secret-token': supplied };
    const response = await createHandler(deps)(http({ headers }), {} as never);
    expect(response).toMatchObject({ statusCode: 403 });
    expect(deps.router.handle).not.toHaveBeenCalled();
  });

  it('gives HTTP shape precedence over a TimerMessage-shaped body and requires the secret', async () => {
    const deps = fixture();
    const response = await createHandler(deps)({
      ...timer(), httpMethod: 'POST', headers: {}, body: timer(),
    }, {} as never);
    expect(response).toMatchObject({ statusCode: 403 });
    expect(deps.scheduler.tick).not.toHaveBeenCalled();
  });

  it('returns 500 with correlation ID when router throws so Telegram retries', async () => {
    const deps = fixture();
    deps.router.handle.mockRejectedValue(new Error(`failure containing ${SECRET}`));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await createHandler(deps)(http(), {} as never);
    expect(response).toMatchObject({ statusCode: 500 });
    expect(response.body).toContain('corr-123');
    expect(response.body).not.toContain(SECRET);
    expect(logged).toHaveBeenCalledOnce();
    const record = logged.mock.calls[0]?.[0] as string;
    expect(record).toContain('corr-123');
    expect(record).not.toContain(SECRET);
  });

  it('returns 200 for duplicate deliveries reported as successful by the router', async () => {
    const deps = fixture();
    const handler = createHandler(deps);
    expect((await handler(http(), {} as never)).statusCode).toBe(200);
    expect((await handler(http(), {} as never)).statusCode).toBe(200);
    expect(deps.router.handle).toHaveBeenCalledTimes(2);
  });

  it('never logs untrusted HTTP body or headers on an unhandled error', async () => {
    const deps = fixture();
    const bodyMarker = 'PRIVATE_BODY_MARKER';
    const headerMarker = 'PRIVATE_HEADER_MARKER';
    deps.router.handle.mockRejectedValue(new Error('safe failure'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await createHandler(deps)(http({
      headers: {
        'x-telegram-bot-api-secret-token': SECRET,
        'x-private': headerMarker,
      },
      body: JSON.stringify({ update_id: 77, text: bodyMarker }),
    }), {} as never);
    const output = logged.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('corr-123');
    expect(output).not.toContain(bodyMarker);
    expect(output).not.toContain(headerMarker);
    expect(output).not.toContain(SECRET);
  });
});

describe('createHandler timer and initialization shapes', () => {
  it('runs scheduler and outbox for a Yandex TimerMessage', async () => {
    const deps = fixture();
    const response = await createHandler(deps)(timer(), {} as never);
    expect(response).toMatchObject({ statusCode: 200 });
    expect(deps.scheduler.tick).toHaveBeenCalledOnce();
    expect(deps.outbox.flush).toHaveBeenCalledWith(10);
    expect(deps.router.handle).not.toHaveBeenCalled();
  });

  it('logs a timer failure with correlation ID and rethrows for retry', async () => {
    const deps = fixture();
    deps.scheduler.tick.mockRejectedValue(new Error(`timer ${SECRET}`));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(createHandler(deps)(timer(), {} as never)).rejects.toThrow();
    const record = String(logged.mock.calls[0]?.[0]);
    expect(record).toContain('corr-123');
    expect(record).not.toContain(SECRET);
  });

  it('rejects unsupported non-HTTP envelopes without invoking dependencies', async () => {
    const deps = fixture();
    const response = await createHandler(deps)({ messages: [] }, {} as never);
    expect(response).toMatchObject({ statusCode: 400 });
    expect(deps.router.handle).not.toHaveBeenCalled();
    expect(deps.scheduler.tick).not.toHaveBeenCalled();
  });

  it('keeps production dependency initialization lazy at module import', async () => {
    vi.resetModules();
    const previous = process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_SECRET;
    await expect(import('../src/handler')).resolves.toHaveProperty('handler');
    if (previous === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = previous;
  });
});

describe('Telegram retry-after transport', () => {
  it('preserves authoritative retry_after when Telegram description omits it', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false, description: 'Too Many Requests', parameters: { retry_after: 75 },
    }), { status: 429, headers: { 'content-type': 'application/json' } }));
    const response = await createRetryAfterPreservingFetcher(upstream)('https://api.telegram.test', { method: 'POST' });
    const payload = await response.json() as { description: string };
    expect(payload.description).toContain('retry after 75');
  });

  it('passes non-rate-limit responses through unchanged', async () => {
    const original = new Response('{"ok":true}', { status: 200 });
    const upstream = vi.fn().mockResolvedValue(original);
    expect(await createRetryAfterPreservingFetcher(upstream)('https://api.telegram.test', {})).toBe(original);
  });
});
