import { useState } from 'react';
import { ArrowRight, Check, ExternalLink, LockKeyhole, Search } from 'lucide-react';
import type { Achievement, Health, MintJob } from '../types';
import { MintModal, MintStatus, statuses } from '../components/Mint';
import { BadgeArt } from '../components/BadgeArt';
import { date, EmptyState, number } from '../components/UI';

const rarityLabels = { common: 'Обычное', rare: 'Редкое', epic: 'Эпическое' };
function MintArea({ achievement, canMint, onMint }: { achievement: Achievement; canMint: boolean; onMint: () => void }) {
  const mint = achievement.mint;
  if (!mint) return <div className="card-mint"><button className="button primary card-mint-button" disabled={!canMint} onClick={onMint}>Получить NFT <ArrowRight size={15} /></button>{!canMint && <span className="field-hint">Выпуск NFT сейчас отключён</span>}</div>;
  const status = statuses[mint.status];
  return <div className="card-mint"><div className="card-mint-line"><span className={`mint-status ${mint.status}`}><status.Icon size={14} aria-hidden="true" />NFT: {status.label.toLocaleLowerCase('ru')}</span>
    {mint.status === 'confirmed' && mint.itemAddress && <a className="text-button" href={`https://testnet.tonviewer.com/${encodeURIComponent(mint.itemAddress)}`} target="_blank" rel="noopener noreferrer">В обозревателе <ExternalLink size={13} /></a>}</div>
    <details className="card-mint-details"><summary>Данные заявки</summary><MintStatus mint={mint} /></details></div>;
}
export function AchievementCard({ achievement, canMint = false, onMint }: { achievement: Achievement; canMint?: boolean; onMint?: () => void }) {
  const progress = Math.min(achievement.progress, achievement.target);
  return <article className={`achievement-card ${achievement.unlocked ? 'unlocked' : ''}`}>
    <div className="achievement-art"><span className={`rarity ${achievement.rarity}`}>{rarityLabels[achievement.rarity]}</span><BadgeArt seed={achievement.id} rarity={achievement.rarity} muted={!achievement.unlocked} /></div>
    <div className="achievement-body"><div className="card-title"><h3>{achievement.title}</h3>{achievement.unlocked ? <Check size={17} aria-label="Открыто" /> : <LockKeyhole size={15} aria-label="Не открыто" />}</div><p>{achievement.description}</p>
      <div className="progress-label"><span>{achievement.unlocked ? 'Достижение открыто' : 'Ваш прогресс'}</span><strong>{number(achievement.progress)} <span>/ {number(achievement.target)}</span></strong></div>
      <progress max={achievement.target} value={progress} aria-label={`${achievement.title}: ${achievement.progress} из ${achievement.target}`} />
      {achievement.unlocked && <div className="card-footer"><span>Открыто {achievement.unlockedAt ? date(achievement.unlockedAt) : ''}</span></div>}
      {achievement.unlocked && onMint && <MintArea achievement={achievement} canMint={canMint} onMint={onMint} />}
    </div>
  </article>;
}
export function Catalog({ achievements, health, csrf, onRefresh, onMintCreated }: { achievements: Achievement[]; health: Health | null; csrf: string; onRefresh: () => Promise<void>; onMintCreated: (unlockId: string, mint: MintJob) => void }) {
  const [filter, setFilter] = useState<'all' | 'unlocked' | 'locked'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Achievement | null>(null);
  const canMint = !!health?.chain.configured && !!health.chain.mintingEnabled;
  const items = achievements.filter(a => (filter === 'all' || (filter === 'unlocked' ? a.unlocked : !a.unlocked)) && `${a.title} ${a.description}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')));
  return <><div className="catalog-toolbar"><div className="segmented" role="group" aria-label="Фильтр достижений">{([['all', 'Все'], ['unlocked', 'Открытые'], ['locked', 'Закрытые']] as const).map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}{value === 'all' && <span>{achievements.length}</span>}</button>)}</div><label className="search-field"><Search size={17} aria-hidden="true" /><input aria-label="Поиск достижений" placeholder="Найти достижение" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    <div className="catalog-results" aria-live="polite">{items.length > 0 ? <div className="achievement-grid">{items.map(achievement => <AchievementCard key={achievement.id} achievement={achievement} canMint={canMint} onMint={() => setSelected(achievement)} />)}</div> : <EmptyState title="Ничего не найдено">Измените фильтр или поисковый запрос.</EmptyState>}</div>
    {selected?.unlockId && <MintModal reward={{ unlockId: selected.unlockId, achievementId: selected.id, title: selected.title, unlockedAt: selected.unlockedAt ?? '', mint: selected.mint }} health={health} csrf={csrf} onClose={() => setSelected(null)} onSubmitted={async mint => { onMintCreated(selected.unlockId!, mint); await onRefresh(); }} />}
  </>;
}
