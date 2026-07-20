import type { Participant, Team, TeamMember } from './model';
import type { RandomSource } from '../ports/random';

export interface TeamFormation {
  teams: Team[];
  members: TeamMember[];
}

export function shuffled<T>(values: readonly T[], random: RandomSource): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = random.int(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new Error('RandomSource returned an invalid index');
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export function formTeams(participants: readonly Participant[], random: RandomSource): TeamFormation {
  const active = shuffled(participants.filter((participant) => participant.rosterStatus === 'active').slice(0, 20), random);
  const teamCount = Math.min(4, Math.floor(active.length / 5));
  if (teamCount < 2) return { teams: [], members: [] };

  const sessionId = active[0]!.sessionId;
  const teams = Array.from({ length: teamCount }, (_, index) => ({
    sessionId,
    teamNumber: (index + 1) as Team['teamNumber'],
  }));
  const members: TeamMember[] = [];

  for (let teamIndex = 0; teamIndex < teamCount; teamIndex += 1) {
    for (const participant of active.slice(teamIndex * 5, teamIndex * 5 + 5)) {
      members.push({ ...participant, teamNumber: teams[teamIndex]!.teamNumber, role: 'starter' });
    }
  }
  active.slice(teamCount * 5).forEach((participant, index) => {
    members.push({ ...participant, teamNumber: teams[index % teamCount]!.teamNumber, role: 'reserve' });
  });

  return { teams, members };
}
