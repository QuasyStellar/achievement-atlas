export interface Counters { matches: number; wins: number; kills: number; xp: number }
export interface AchievementDefinition {
  id: string; title: string; description: string; metric: keyof Counters;
  target: number; rarity: 'common' | 'rare' | 'epic'; icon: string;
}
export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  { id: 'first_match', title: 'Первый шаг', description: 'Завершите первый матч.', metric: 'matches', target: 1, rarity: 'common', icon: 'flag' },
  { id: '10_matches', title: 'В строю', description: 'Завершите 10 матчей.', metric: 'matches', target: 10, rarity: 'rare', icon: 'swords' },
  { id: 'first_win', title: 'Первая победа', description: 'Выиграйте первый матч.', metric: 'wins', target: 1, rarity: 'common', icon: 'trophy' },
  { id: '5_wins', title: 'Победная серия', description: 'Одержите 5 побед.', metric: 'wins', target: 5, rarity: 'rare', icon: 'crown' },
  { id: '100_kills', title: 'Мастер боя', description: 'Совершите 100 устранений.', metric: 'kills', target: 100, rarity: 'epic', icon: 'crosshair' },
  { id: '1000_xp', title: 'Новый уровень', description: 'Заработайте 1000 опыта.', metric: 'xp', target: 1000, rarity: 'epic', icon: 'sparkles' },
];
export type GameEvent = {
  eventId: string; playerId: string; occurredAt: string;
} & ({ type: 'match.completed'; payload: { won: boolean } }
  | { type: 'combat.completed'; payload: { kills: number } }
  | { type: 'xp.earned'; payload: { xp: number } });
export function applyEvent(counters: Counters, event: GameEvent): Counters {
  const next = { ...counters };
  switch (event.type) {
    case 'match.completed': next.matches++; if (event.payload.won) next.wins++; break;
    case 'combat.completed': next.kills += event.payload.kills; break;
    case 'xp.earned': next.xp += event.payload.xp; break;
  }
  if (Object.values(next).some(value => !Number.isSafeInteger(value))) throw new Error('Counter limit exceeded');
  return next;
}
export function eligibleAchievements(counters: Counters, existing: ReadonlySet<string>): string[] {
  return ACHIEVEMENTS.filter(a => !existing.has(a.id) && counters[a.metric] >= a.target).map(a => a.id);
}
