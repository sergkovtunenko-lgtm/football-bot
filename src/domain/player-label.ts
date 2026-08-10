export interface PlayerLabelSource {
  displayName?: string;
  username?: string;
}

export function playerLabel(source: PlayerLabelSource, historicalDisplayName?: string): string {
  const name = source.displayName?.trim();
  if (name) return name;
  const username = source.username?.trim().replace(/^@+/, '');
  if (username) return `@${username}`;
  return historicalDisplayName?.trim() || 'Игрок';
}
