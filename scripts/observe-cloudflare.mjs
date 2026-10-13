import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Only operational timings leave this process; Telegram payloads and log bodies do not.
const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'tail',
  '--config', 'wrangler.bot.jsonc', '--format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  while (true) {
    const start = buffer.indexOf('{');
    if (start < 0) { buffer = ''; return; }
    let depth = 0; let quoted = false; let escaped = false; let end = -1;
    for (let index = start; index < buffer.length; index++) {
      const character = buffer[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) { end = index + 1; break; }
    }
    if (end < 0) { buffer = buffer.slice(start); return; }
    try {
      const event = JSON.parse(buffer.slice(start, end));
      console.log(JSON.stringify({ outcome: event.outcome, cpuTime: event.cpuTime, wallTime: event.wallTime,
        eventTimestamp: event.eventTimestamp, trigger: event.event?.cron ? 'cron' : event.event?.queue ? 'queue' : 'http',
        exceptions: event.exceptions?.length ?? 0 }));
    } catch { console.log('Could not parse an operational event'); }
    buffer = buffer.slice(end);
  }
});
child.stderr.on('data', () => {});
setTimeout(() => child.kill(), 60_000);
