import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// @ts-expect-error The production utility intentionally ships as native ESM.
import { getWebhookInfo, loadInput, setWebhook } from '../../scripts/set-webhook.mjs';

const input = {
  botToken: '123456789:' + 'abcdefghijklmnopqrstuvwxyzABCDEFGH_12',
  webhookSecret: 'valid_secret_1234567890',
  functionUrl: 'https://friday-football-bot-ingress.football-sergei.workers.dev/telegram',
};

describe('setWebhook', () => {
  it('sends the exact secure webhook configuration', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await setWebhook(fetcher, input);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe(
      `https://api.telegram.org/bot${input.botToken}/setWebhook`,
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      url: 'https://friday-football-bot-ingress.football-sergei.workers.dev/telegram',
      secret_token: 'valid_secret_1234567890',
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
      max_connections: 1,
    });
  });

  it('throws on a failed Bot API response without exposing the token', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      description: `request failed for ${input.botToken}`,
    }), { status: 401 }));

    let thrown: unknown;
    try {
      await setWebhook(fetcher, input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(input.botToken);
  });

  it('wraps a rejected transport error without exposing its token URL', async () => {
    const rawUrl = `https://api.telegram.org/bot${input.botToken}/setWebhook`;
    const fetcher = vi.fn().mockRejectedValue(new Error(`connect failed: ${rawUrl}`));

    let thrown: unknown;
    try {
      await setWebhook(fetcher, input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Telegram transport request failed');
    expect((thrown as Error).message).not.toContain(input.botToken);
    expect((thrown as Error).message).not.toContain(rawUrl);
  });

  it('prints only the fixed transport error when run as a script', () => {
    const rawUrl = `https://api.telegram.org/bot${input.botToken}/setWebhook`;
    const preload = `globalThis.fetch = async () => { throw new Error(${JSON.stringify(rawUrl)}) }`;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      resolve(__dirname, '../../scripts/set-webhook.mjs'),
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOT_TOKEN: input.botToken,
        WEBHOOK_SECRET: input.webhookSecret,
        FUNCTION_URL: input.functionUrl,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Telegram transport request failed');
    expect(result.stderr).not.toContain(input.botToken);
    expect(result.stderr).not.toContain(rawUrl);
  });
});

describe('loadInput', () => {
  it('accepts the exact Cloudflare Worker route used for the durable ingress', () => {
    expect(loadInput({
      BOT_TOKEN: input.botToken,
      WEBHOOK_SECRET: input.webhookSecret,
      FUNCTION_URL: 'https://friday-football-bot-ingress.football-sergei.workers.dev/telegram',
    }).functionUrl).toBe(
      'https://friday-football-bot-ingress.football-sergei.workers.dev/telegram',
    );
  });

  it('rejects a lookalike Cloudflare Worker host', () => {
    expect(() => loadInput({
      BOT_TOKEN: input.botToken,
      WEBHOOK_SECRET: input.webhookSecret,
      FUNCTION_URL: 'https://worker.account.workers.dev.evil.example/telegram',
    })).toThrow('Invalid FUNCTION_URL');
  });

  it('rejects a different but syntactically valid Workers host', () => {
    expect(() => loadInput({
      BOT_TOKEN: input.botToken,
      WEBHOOK_SECRET: input.webhookSecret,
      FUNCTION_URL: 'https://friday-football-bot-ingress.other-account.workers.dev/telegram',
    })).toThrow('Invalid FUNCTION_URL');
  });

  it('rejects bypassing the durable ingress with a direct function URL', () => {
    expect(() => loadInput({
      BOT_TOKEN: input.botToken,
      WEBHOOK_SECRET: input.webhookSecret,
      FUNCTION_URL: 'https://functions.yandexcloud.net/function-id?tag=stable',
    })).toThrow('Invalid FUNCTION_URL');
  });
});

describe('getWebhookInfo', () => {
  it('returns a verified pending update count', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: {
        url: input.functionUrl,
        pending_update_count: 3,
      },
    }), { status: 200 }));

    await expect(getWebhookInfo(fetcher, input)).resolves.toEqual({ pendingUpdateCount: 3 });
  });

  it('rejects a webhook URL that does not match', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: {
        url: 'https://other-worker.other-account.workers.dev/telegram',
        pending_update_count: 0,
      },
    }), { status: 200 }));

    await expect(getWebhookInfo(fetcher, input)).rejects.toThrow('Webhook verification failed');
  });

  it('rejects an invalid pending update count', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: {
        url: input.functionUrl,
        pending_update_count: -1,
      },
    }), { status: 200 }));

    await expect(getWebhookInfo(fetcher, input)).rejects.toThrow('Webhook verification failed');
  });

  it('rejects a Telegram-reported webhook error', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: {
        url: input.functionUrl,
        pending_update_count: 0,
        last_error_message: 'upstream failed',
      },
    }), { status: 200 }));

    await expect(getWebhookInfo(fetcher, input)).rejects.toThrow('Webhook verification failed');
  });
});
