import type { TeamMember, WinAward, WinEvent } from './model';

export interface LeaderboardRow {
  rank: number;
  telegramUserId: string;
  displayName: string;
  wins: number;
}

export function awardsForWin(
  sessionId: string,
  winOrdinal: bigint,
  members: readonly TeamMember[],
): WinAward[] {
  return members.flatMap((member) => member.kind === 'player' && member.telegramUserId ? [{
    sessionId,
    winOrdinal,
    telegramUserId: member.telegramUserId,
    displayName: member.displayName,
  }] : []);
}

export function lastReversibleWin(events: readonly WinEvent[]): WinEvent | undefined {
  if (new Set(events.map((event) => event.sessionId)).size > 1) {
    throw new Error('Win events must belong to one session');
  }
  return events.filter((event) => !event.reversedAtIso)
    .sort((a, b) => (a.ordinal > b.ordinal ? -1 : 1))[0];
}

export function dailyPlayerWins(
  sessionId: string,
  events: readonly WinEvent[],
  awards: readonly WinAward[],
): ReadonlyMap<string, number> {
  const active = new Set(events
    .filter((event) => event.sessionId === sessionId && !event.reversedAtIso)
    .map((event) => `${event.sessionId}:${event.ordinal}`));
  const wins = new Map<string, number>();
  for (const award of awards) {
    if (!active.has(`${award.sessionId}:${award.winOrdinal}`)) continue;
    wins.set(award.telegramUserId, (wins.get(award.telegramUserId) ?? 0) + 1);
  }
  return wins;
}

export function buildLeaderboard(
  events: readonly WinEvent[],
  awards: readonly WinAward[],
  completedSessionIds: ReadonlySet<string>,
  currentDisplayNames: ReadonlyMap<string, string>,
): LeaderboardRow[] {
  const active = new Set(events
    .filter((event) => completedSessionIds.has(event.sessionId) && !event.reversedAtIso)
    .map((event) => `${event.sessionId}:${event.ordinal}`));
  const rows = new Map<string, { displayName: string; wins: number }>();
  for (const award of awards) {
    if (!active.has(`${award.sessionId}:${award.winOrdinal}`)) continue;
    const displayName = currentDisplayNames.get(award.telegramUserId) ?? award.displayName;
    const current = rows.get(award.telegramUserId) ?? { displayName, wins: 0 };
    rows.set(award.telegramUserId, { displayName, wins: current.wins + 1 });
  }
  const sorted = [...rows].map(([telegramUserId, value]) => ({ telegramUserId, ...value }))
    .sort((a, b) => b.wins - a.wins
      || a.displayName.localeCompare(b.displayName, 'ru')
      || a.telegramUserId.localeCompare(b.telegramUserId));
  const ranked: LeaderboardRow[] = [];
  for (const [index, row] of sorted.entries()) {
    const previous = ranked[index - 1];
    ranked.push({
      ...row,
      rank: previous && previous.wins === row.wins ? previous.rank : index + 1,
    });
  }
  return ranked;
}
