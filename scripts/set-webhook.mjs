import { fileURLToPath } from 'node:url';

const TOKEN_PATTERN = /^\d{8,12}:[A-Za-z0-9_-]{30,}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export async function setWebhook(fetcher, input) {
  const response = await fetchSafely(fetcher, methodUrl(input.botToken, 'setWebhook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: input.functionUrl,
      secret_token: input.webhookSecret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    }),
  });
  const payload = await readPayload(response);
  if (!response.ok || payload.ok !== true || payload.result !== true) {
    throw new Error('Telegram setWebhook request failed');
  }
}

export async function getWebhookInfo(fetcher, input) {
  const response = await fetchSafely(
    fetcher,
    methodUrl(input.botToken, 'getWebhookInfo'),
    { method: 'GET' },
  );
  const payload = await readPayload(response);
  const result = payload.result;
  if (
    !response.ok
    || payload.ok !== true
    || !isRecord(result)
    || result.url !== input.functionUrl
    || Object.prototype.hasOwnProperty.call(result, 'last_error_message')
    || !Number.isInteger(result.pending_update_count)
    || result.pending_update_count < 0
  ) {
    throw new Error('Webhook verification failed');
  }
  return { pendingUpdateCount: result.pending_update_count };
}

export function loadInput(env = process.env) {
  const botToken = required(env, 'BOT_TOKEN');
  const webhookSecret = required(env, 'WEBHOOK_SECRET');
  const functionUrl = required(env, 'FUNCTION_URL');
  if (!TOKEN_PATTERN.test(botToken)) throw new Error('Invalid BOT_TOKEN');
  if (!SECRET_PATTERN.test(webhookSecret)) throw new Error('Invalid WEBHOOK_SECRET');
  let parsedUrl;
  try {
    parsedUrl = new URL(functionUrl);
  } catch {
    throw new Error('Invalid FUNCTION_URL');
  }
  if (
    parsedUrl.protocol !== 'https:'
    || parsedUrl.username !== ''
    || parsedUrl.password !== ''
    || parsedUrl.hostname !== 'functions.yandexcloud.net'
    || parsedUrl.searchParams.get('tag') !== 'stable'
  ) {
    throw new Error('Invalid FUNCTION_URL');
  }
  return { botToken, webhookSecret, functionUrl: parsedUrl.toString() };
}

export async function main() {
  const input = loadInput();
  await setWebhook(globalThis.fetch, input);
  const info = await getWebhookInfo(globalThis.fetch, input);
  console.log(`Webhook verified. Pending updates: ${info.pendingUpdateCount}`);
}

function methodUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function fetchSafely(fetcher, url, init) {
  try {
    return await fetcher(url, init);
  } catch {
    throw new Error('Telegram transport request failed');
  }
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function readPayload(response) {
  try {
    const payload = await response.json();
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Webhook setup failed');
    process.exitCode = 1;
  });
}
