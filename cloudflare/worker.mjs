const TELEGRAM_PATH = '/telegram';
const MAX_UPDATE_BYTES = 128_000;
const YANDEX_FUNCTION_HOST = 'functions.yandexcloud.net';

export function createWorker(fetcher) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname !== TELEGRAM_PATH) {
        return textResponse(404, 'not found');
      }
      if (request.method !== 'POST') {
        return textResponse(405, 'method not allowed', { allow: 'POST' });
      }
      if (!validSecretEnvironment(env)) {
        return textResponse(503, 'unavailable');
      }
      const suppliedSecret = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
      if (!constantTimeEqual(suppliedSecret, env.WEBHOOK_SECRET)) {
        return textResponse(403, 'forbidden');
      }
      const declaredLength = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_UPDATE_BYTES) {
        return textResponse(413, 'payload too large');
      }
      let rawBody;
      try {
        rawBody = await request.text();
      } catch {
        return textResponse(400, 'bad request');
      }
      if (new TextEncoder().encode(rawBody).byteLength > MAX_UPDATE_BYTES) {
        return textResponse(413, 'payload too large');
      }
      let update;
      try {
        update = JSON.parse(rawBody);
      } catch {
        return textResponse(400, 'bad request');
      }
      if (!validTelegramUpdate(update)) {
        return textResponse(400, 'bad request');
      }
      try {
        await env.TELEGRAM_UPDATES.send(update);
      } catch {
        return textResponse(503, 'queue unavailable');
      }
      return textResponse(200, 'ok');
    },

    async queue(batch, env) {
      for (const message of batch.messages) {
        if (!validTelegramUpdate(message.body)) {
          message.ack();
          continue;
        }
        const retry = () => message.retry({
          delaySeconds: retryDelaySeconds(message.attempts),
        });
        const destination = safeYandexFunctionUrl(env.YANDEX_FUNCTION_URL);
        if (
          destination === undefined
          || typeof env.WEBHOOK_SECRET !== 'string'
          || env.WEBHOOK_SECRET.length === 0
        ) {
          retry();
          continue;
        }
        try {
          const response = await fetcher(destination, {
            method: 'POST',
            redirect: 'manual',
            headers: {
              'content-type': 'application/json',
              'x-telegram-bot-api-secret-token': env.WEBHOOK_SECRET,
            },
            body: JSON.stringify(message.body),
            signal: AbortSignal.timeout(40_000),
          });
          if (!response.ok) {
            retry();
            continue;
          }
          message.ack();
        } catch {
          retry();
        }
      }
    },
  };
}

function validSecretEnvironment(env) {
  return typeof env?.WEBHOOK_SECRET === 'string'
    && /^[A-Za-z0-9_-]{16,256}$/.test(env.WEBHOOK_SECRET)
    && typeof env?.TELEGRAM_UPDATES?.send === 'function';
}

function validTelegramUpdate(value) {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Number.isSafeInteger(value.update_id);
}

function safeYandexFunctionUrl(value) {
  if (typeof value !== 'string') return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== YANDEX_FUNCTION_HOST
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || !/^\/[a-z0-9]+$/.test(url.pathname)
    || url.searchParams.size !== 1
    || url.searchParams.get('tag') !== 'stable'
  ) {
    return undefined;
  }
  return url.toString();
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function retryDelaySeconds(attempts) {
  const safeAttempts = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  return Math.min(30 * (2 ** Math.min(safeAttempts - 1, 5)), 900);
}

function textResponse(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export default createWorker(globalThis.fetch);
