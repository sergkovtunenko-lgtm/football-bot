export const MIN_GAME_PLAYERS = 11;

export function rentalForPlayers(count: number): { minutes: 60 | 90 | 120; totalRubles: number } | undefined {
  if (count < MIN_GAME_PLAYERS) return undefined;
  if (count === 20) return { minutes: 120, totalRubles: 13250 };
  if (count >= 13) return { minutes: 90, totalRubles: 9750 };
  return { minutes: 60, totalRubles: 6750 };
}
