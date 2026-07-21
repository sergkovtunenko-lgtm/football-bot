const TELEGRAM_TOKEN = /[0-9]{8,12}:[A-Za-z0-9_-]{30,}/g;

export function redactTelegramTokens(value: string): string {
  return value.replace(TELEGRAM_TOKEN, '[redacted]');
}
