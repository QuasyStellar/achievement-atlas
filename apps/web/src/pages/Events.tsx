import { Check, Crosshair, Gamepad2, Sparkles } from 'lucide-react';
import type { Achievement, GameEvent } from '../types';
import { date, EmptyState, number } from '../components/UI';

function describe(event: GameEvent) {
  if (event.type === 'match.completed') return { title: event.payload.won === true ? 'Победа в матче' : 'Матч завершён', detail: event.payload.won === true ? '+1 матч, +1 победа' : '+1 матч', Icon: event.payload.won === true ? Check : Gamepad2 };
  if (event.type === 'combat.completed') return { title: 'Боевой результат', detail: typeof event.payload.kills === 'number' ? `+${number(event.payload.kills)} устранений` : 'Результат получен от игрового сервера', Icon: Crosshair };
  if (event.type === 'xp.earned') return { title: 'Получен опыт', detail: typeof event.payload.xp === 'number' ? `+${number(event.payload.xp)} опыта` : 'Опыт получен от игрового сервера', Icon: Sparkles };
  return { title: event.type, detail: 'Событие от игрового сервера', Icon: Gamepad2 };
}
export function Events({ events, achievements }: { events: GameEvent[]; achievements: Achievement[] }) {
  const titles = new Map(achievements.map(a => [a.id, a.title]));
  const ordered = [...events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.id.localeCompare(a.id));
  if (!ordered.length) return <EmptyState title="Событий пока нет">Они появятся здесь, когда игра передаст первое событие.</EmptyState>;
  return <section className="event-history"><div className="section-heading"><h2>Игровые события</h2><span>Всего: {number(ordered.length)}</span></div><ol className="event-list">{ordered.map(event => { const { title, detail, Icon } = describe(event); return <li key={event.id}><div className="event-marker"><Icon size={19} aria-hidden="true" /></div><div className="event-copy"><h3>{title}</h3><p>{detail}</p>{event.unlocked?.length > 0 && <p className="event-unlocked">Открыто: {event.unlocked.map(id => titles.get(id) ?? id).join(', ')}</p>}<details><summary>Идентификатор события</summary><code>{event.eventId}</code></details></div><time dateTime={event.occurredAt}>{date(event.occurredAt)}</time></li>; })}</ol></section>;
}
