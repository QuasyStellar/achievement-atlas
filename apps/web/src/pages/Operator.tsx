import { useEffect, useState, type FormEvent } from 'react';
import { FlaskConical, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { errorText, request } from '../api';
import type { Health, Scenario, SimulationResponse, User, UsersResponse } from '../types';
import { ErrorNotice, Loading, number } from '../components/UI';

const scenarios: { value: Scenario; title: string; description: string }[] = [
  { value: 'first-match', title: 'Матч без победы', description: '+1 матч' },
  { value: 'victory', title: 'Победа', description: '+1 матч, +1 победа' },
  { value: 'ten-matches', title: '10 матчей', description: '+10 матчей' },
  { value: 'hundred-kills', title: '100 устранений', description: '+100 устранений' },
  { value: 'thousand-xp', title: '1 000 XP', description: '+1000 опыта' },
];
export function Operator({ health, csrf, onRefresh }: { health: Health | null; csrf: string; onRefresh: () => Promise<void> }) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [userId, setUserId] = useState('');
  const [scenario, setScenario] = useState<Scenario>('first-match');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimulationResponse | null>(null);
  async function load() {
    setLoading(true); setError('');
    try { const data = await request<UsersResponse>('/operator/users'); setUsers(data.users); setUserId(current => data.users.some(user => user.id === current) ? current : data.users[0]?.id ?? ''); }
    catch (error) { setError(errorText(error)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function simulate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!health?.demoMode || !userId || busy) return;
    setBusy(true); setError(''); setResult(null);
    try { const data = await request<SimulationResponse>('/operator/simulate', { method: 'POST', csrf, body: { userId, scenario } }); setResult(data); await onRefresh(); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  return <section className="operator-panel"><div className="operator-notice"><FlaskConical size={22} aria-hidden="true" /><div><h2>Симулятор игрового сервера</h2><p>Выберите игрока и событие. Сервис обработает его так же, как событие от настоящей игры.</p></div></div>
    {!health?.demoMode && <ErrorNotice message={health ? 'Режим демонстрации выключен. Симуляция недоступна.' : 'Конфигурация сервиса недоступна. Симуляция заблокирована.'} />}
    {loading ? <Loading label="Загружаем пользователей…" /> : <form className="operator-form" onSubmit={simulate}><div className="operator-user"><label>Игрок<select value={userId} onChange={event => { setUserId(event.target.value); setResult(null); }} disabled={busy || !users.length} required>{!users.length && <option value="">Пользователей пока нет</option>}{users.map(user => <option key={user.id} value={user.id}>{user.displayName} · {user.email}</option>)}</select></label><button type="button" className="icon-button" onClick={() => void load()} disabled={busy} aria-label="Обновить список пользователей"><RefreshCw size={18} /></button></div>
      <fieldset disabled={busy}><legend>Сценарий события</legend><div className="scenario-list">{scenarios.map(item => <label key={item.value} className={`scenario-option ${scenario === item.value ? 'selected' : ''}`}><input type="radio" name="scenario" checked={scenario === item.value} onChange={() => { setScenario(item.value); setResult(null); }} /><span><strong>{item.title}</strong><span>{item.description}</span></span></label>)}</div></fieldset>
      <button className="button primary" disabled={busy || !health?.demoMode || !userId || !csrf} type="submit">{busy ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}{busy ? 'Обрабатываем события…' : 'Запустить сценарий'}</button>
    </form>}
    {error && <ErrorNotice message={error} retry={() => void load()} />}
    {result && <div className="simulation-result" role="status"><strong>Сценарий обработан</strong><p>Обработано событий: {number(result.processed)}. Открыто достижений: {number(result.unlocked.length)}.</p><p>Статистика выбранного игрока обновлена; он увидит изменения в обзоре и каталоге.</p></div>}
  </section>;
}
