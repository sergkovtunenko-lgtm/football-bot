export interface AppConfig {
  botToken: string;
  webhookSecret: string;
  adminIds: ReadonlySet<string>;
  ydbConnectionString: string;
  timeZone: 'Europe/Moscow';
  maxActiveParticipants: 20;
}

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const webhookSecret = required(env, 'WEBHOOK_SECRET');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
    throw new Error('Invalid WEBHOOK_SECRET');
  }
  const adminIds = new Set(required(env, 'ADMIN_IDS').split(',').map((id) => id.trim()));
  if ([...adminIds].some((id) => !/^-?\d+$/.test(id))) throw new Error('Invalid ADMIN_IDS');
  return {
    botToken: required(env, 'BOT_TOKEN'),
    webhookSecret,
    adminIds,
    ydbConnectionString: required(env, 'YDB_CONNECTION_STRING'),
    timeZone: 'Europe/Moscow',
    maxActiveParticipants: 20,
  };
}
