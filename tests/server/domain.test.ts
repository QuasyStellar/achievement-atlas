import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, applyEvent, eligibleAchievements, type GameEvent } from '../../apps/server/src/domain/achievements.js';

const base = { eventId: 'event-1', playerId: 'player', occurredAt: '2026-09-30T12:00:00Z' };
describe('pure achievement rules', () => {
  it('uses six exact thresholds and does not award a repeated unlock', () => {
    expect(ACHIEVEMENTS.map(a => a.id)).toEqual(['first_match', '10_matches', 'first_win', '5_wins', '100_kills', '1000_xp']);
    expect(eligibleAchievements({ matches: 9, wins: 4, kills: 99, xp: 999 }, new Set(['first_match', 'first_win']))).toEqual([]);
    expect(eligibleAchievements({ matches: 10, wins: 5, kills: 100, xp: 1000 }, new Set())).toHaveLength(6);
  });
  it('counts only the metrics represented by each trusted event', () => {
    const initial = { matches: 0, wins: 0, kills: 0, xp: 0 };
    const won: GameEvent = { ...base, type: 'match.completed', payload: { won: true } };
    expect(applyEvent(initial, won)).toEqual({ matches: 1, wins: 1, kills: 0, xp: 0 });
    expect(initial.matches).toBe(0);
    expect(applyEvent(initial, { ...base, type: 'combat.completed', payload: { kills: 100 } }).kills).toBe(100);
    expect(applyEvent(initial, { ...base, type: 'xp.earned', payload: { xp: 1000 } }).xp).toBe(1000);
  });
  it('rejects overflow without mutating input', () => {
    expect(() => applyEvent({ matches: Number.MAX_SAFE_INTEGER, wins: 0, kills: 0, xp: 0 }, { ...base, type: 'match.completed', payload: { won: false } })).toThrow();
  });
});
