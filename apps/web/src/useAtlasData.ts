import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorText, request } from './api';
import type { AchievementsResponse, EventsResponse, MintJob, RewardsResponse, User } from './types';

type AtlasData = AchievementsResponse & EventsResponse & RewardsResponse;
export function useAtlasData(user: User | null) {
  const [data, setData] = useState<AtlasData | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!user) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const [achievements, events, rewards] = await Promise.all([
        request<AchievementsResponse>('/achievements'), request<EventsResponse>('/events'), request<RewardsResponse>('/rewards'),
      ]);
      if (current === generation.current) { setData({ ...achievements, ...events, ...rewards }); setOwnerId(user.id); setUnauthorized(false); setError(''); }
    } catch (error) {
      if (current === generation.current) { setError(errorText(error)); setUnauthorized(error instanceof ApiError && error.status === 401); }
    }
    finally { if (current === generation.current) setLoading(false); }
  }, [user?.id]);
  useEffect(() => {
    ++generation.current; setData(null); setOwnerId(null); setUnauthorized(false); setError(''); setLoading(false);
    if (user) void refresh();
    return () => { ++generation.current; };
  }, [user?.id, refresh]);
  const hasActiveMints = data?.rewards.some(reward => reward.mint?.status === 'pending' || reward.mint?.status === 'submitted');
  useEffect(() => {
    if (!hasActiveMints || !user || loading) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [hasActiveMints, user?.id, refresh, loading]);
  function recordMint(unlockId: string, mint: MintJob) {
    setData(current => current ? { ...current, rewards: current.rewards.map(reward => reward.unlockId === unlockId ? { ...reward, mint } : reward), achievements: current.achievements.map(achievement => achievement.unlockId === unlockId ? { ...achievement, mint } : achievement) } : current);
  }
  return { data: ownerId === user?.id ? data : null, loading, error, unauthorized, refresh, recordMint };
}
