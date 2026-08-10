import type { PlayerProfile, TeamMember, WinAward, WinEvent } from './model';
import { playerLabel } from './player-label';

export interface LeaderboardRow {
  rank: number;
  telegramUserId: string;
  displayName: string;
  wins: number;
  evenings: number;
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
  teamMembers: readonly TeamMember[],
  currentPlayers: ReadonlyMap<string, PlayerProfile>,
): LeaderboardRow[] {
  const active = new Set(events
    .filter((event) => completedSessionIds.has(event.sessionId) && !event.reversedAtIso)
    .map((event) => `${event.sessionId}:${event.ordinal}`));
  const rows = new Map<string, { displayName: string; wins: number; evenings: number }>();
  const attended = new Set<string>();
  const labelFor = (telegramUserId: string, historicalDisplayName: string): string => playerLabel(
    currentPlayers.get(telegramUserId) ?? {},
    historicalDisplayName,
  );
  for (const member of teamMembers) {
    if (!completedSessionIds.has(member.sessionId)
      || member.kind !== 'player'
      || member.telegramUserId === undefined) continue;
    const attendanceKey = `${member.sessionId}:${member.telegramUserId}`;
    if (attended.has(attendanceKey)) continue;
    attended.add(attendanceKey);
    const current = rows.get(member.telegramUserId);
    rows.set(member.telegramUserId, {
      displayName: labelFor(member.telegramUserId, member.displayName),
      wins: current?.wins ?? 0,
      evenings: (current?.evenings ?? 0) + 1,
    });
  }
  for (const award of awards) {
    if (!active.has(`${award.sessionId}:${award.winOrdinal}`)) continue;
    const current = rows.get(award.telegramUserId);
    rows.set(award.telegramUserId, {
      displayName: labelFor(award.telegramUserId, award.displayName),
      wins: (current?.wins ?? 0) + 1,
      evenings: current?.evenings ?? 0,
    });
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
