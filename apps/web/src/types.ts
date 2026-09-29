export type User = { id: string; email: string; displayName: string; role: 'player' | 'operator' };
export type MintJob = {
  id: string; status: 'pending' | 'submitted' | 'confirmed' | 'failed'; recipient: string;
  itemIndex: number | null; itemAddress: string | null; transactionHash: string | null;
  error: string | null; createdAt: string; updatedAt: string;
};
export type Achievement = {
  id: string; title: string; description: string; metric: 'matches' | 'wins' | 'kills' | 'xp';
  target: number; rarity: 'common' | 'rare' | 'epic'; icon: string; progress: number;
  unlocked: boolean; unlockedAt: string | null; unlockId: string | null; mint: MintJob | null;
};
export type Summary = { matches: number; wins: number; kills: number; xp: number; unlocked: number; total: number; minted: number };
export type GameEvent = { id: string; eventId: string; type: string; occurredAt: string; payload: Record<string, unknown>; createdAt: string; unlocked: string[] };
export type Reward = { unlockId: string; achievementId: string; title: string; unlockedAt: string; mint: MintJob | null };
export type Health = {
  status: 'ok'; service: 'achievement-atlas'; network: 'testnet'; demoMode: boolean;
  chain: { configured: boolean; collectionAddress: string | null; walletAddress: string | null; mintingEnabled: boolean;
    permission?: { recipient: string; maxSpendTon: string; remainingMints: number; automaticRetryAllowed: false } };
};
export type MeResponse = { user: User | null; csrfToken: string };
export type AchievementsResponse = { achievements: Achievement[]; summary: Summary };
export type EventsResponse = { events: GameEvent[] };
export type RewardsResponse = { rewards: Reward[] };
export type UsersResponse = { users: User[] };
export type Scenario = 'first-match' | 'victory' | 'ten-matches' | 'hundred-kills' | 'thousand-xp';
export type SimulationResponse = { processed: number; unlocked: string[] };
export type Page = 'overview' | 'catalog' | 'events' | 'operator';
