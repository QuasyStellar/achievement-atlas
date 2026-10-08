import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, ChevronRight, FlaskConical, History, LayoutGrid, LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import { errorText, request } from './api';
import type { Health, MeResponse, Page, User } from './types';
import { useAtlasData } from './useAtlasData';
import { AuthModal } from './components/AuthModal';
import { EmptyState, ErrorNotice, Loading } from './components/UI';
import { Catalog } from './pages/Catalog';
import { Events } from './pages/Events';
import { Operator } from './pages/Operator';
import { Overview, Welcome } from './pages/Overview';

const pages = [
  { id: 'overview', title: 'Обзор', subtitle: 'Игровая статистика и ближайшие достижения.', Icon: LayoutGrid },
  { id: 'catalog', title: 'Каталог достижений', subtitle: 'Условия, прогресс и NFT за открытые достижения.', Icon: BookOpen },
  { id: 'events', title: 'История событий', subtitle: 'События, которые игровой сервер передал для вашего аккаунта.', Icon: History },
  { id: 'operator', title: 'Симулятор игры', subtitle: 'Отправка игровых событий от имени игрового сервера. Только для оператора.', Icon: FlaskConical },
] as const;
function currentPage(): Page {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return pages.some(page => page.id === hash) ? hash as Page : 'overview';
}
type Theme = 'light' | 'dark';
const systemTheme = (): Theme => window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
/** Сохранённый вручную выбор; null — следовать теме устройства. */
function storedTheme(): Theme | null {
  try { const value = localStorage.getItem('atlas-theme'); return value === 'dark' || value === 'light' ? value : null; }
  catch { return null; }
}
export default function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [user, setUser] = useState<User | null>(null);
  const [csrf, setCsrf] = useState('');
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register' | null>(null);
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const { data, loading, error, unauthorized, refresh, recordMint } = useAtlasData(user);
  const pageInfo = pages.find(item => item.id === page)!;

  async function session() {
    const me = await request<MeResponse>('/auth/me');
    setUser(me.user); setCsrf(me.csrfToken); setSessionError('');
  }
  async function initialize() {
    setSessionLoading(true); setSessionError('');
    try { await session(); }
    catch (error) { setSessionError(errorText(error)); }
    finally { setSessionLoading(false); }
  }
  async function loadHealth() {
    try { setHealth(await request<Health>('/health')); setHealthError(''); }
    catch (error) { setHealth(null); setHealthError(errorText(error)); }
  }
  async function refreshAll() { await Promise.all([refresh(), loadHealth()]); }
  useEffect(() => { void initialize(); void loadHealth(); }, []);
  useEffect(() => {
    if (unauthorized) { setUser(null); setCsrf(''); void initialize(); }
  }, [unauthorized]);
  useEffect(() => {
    const handleHash = () => { setPage(currentPage()); setMenuOpen(false); };
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    // Пока пользователь не выбрал тему вручную, интерфейс следует за темой устройства.
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const follow = () => { if (!storedTheme()) setTheme(systemTheme()); };
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);
  function toggleTheme() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    try { localStorage.setItem('atlas-theme', next); }
    catch { /* без хранилища выбор действует до перезагрузки страницы */ }
  }
  useEffect(() => { document.title = `${pageInfo.title} — Achievement Atlas`; }, [pageInfo.title]);
  useEffect(() => { if (!sessionLoading && page === 'operator' && user?.role !== 'operator') navigate('overview'); }, [page, user?.role, sessionLoading]);
  function navigate(next: Page) { window.location.hash = `/${next}`; setPage(next); setMenuOpen(false); }
  async function logout() {
    setLoggingOut(true); setSessionError('');
    try {
      await request<{ ok: true }>('/auth/logout', { method: 'POST', csrf });
      setUser(null); setCsrf(''); navigate('overview');
      await session();
    } catch (error) { setSessionError(errorText(error)); }
    finally { setLoggingOut(false); }
  }
  function content() {
    if (sessionLoading) return <Loading label="Загрузка…" />;
    if (!user) {
      if (page === 'overview') return <Welcome onRegister={() => setAuthMode('register')} onLogin={() => setAuthMode('login')} />;
      return <EmptyState title="Войдите, чтобы увидеть свои достижения" action={<button className="button primary" onClick={() => setAuthMode('register')} disabled={!csrf}>Создать аккаунт <ArrowRight size={17} /></button>}>Каталог, прогресс и история событий доступны после входа.</EmptyState>;
    }
    if (page === 'operator') return user.role === 'operator' ? <Operator health={health} csrf={csrf} onRefresh={refreshAll} /> : null;
    if (!data) return loading ? <Loading /> : <EmptyState title="Данные пока не загружены">Повторите запрос с помощью кнопки выше.</EmptyState>;
    if (page === 'catalog') return <Catalog achievements={data.achievements} health={health} csrf={csrf} onRefresh={refreshAll} onMintCreated={recordMint} />;
    if (page === 'events') return <Events events={data.events} achievements={data.achievements} />;
    return <Overview user={user} summary={data.summary} achievements={data.achievements} onCatalog={() => navigate('catalog')} />;
  }
  return <div className="app-layout"><a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Перейти к содержимому</a><aside className={`sidebar ${menuOpen ? 'open' : ''}`}><div className="sidebar-top"><a className="brand" href="#/overview" aria-label="Achievement Atlas — обзор"><span className="brand-symbol" aria-hidden="true"><span /><span /><span /></span><span>Achievement<strong>Atlas<span className="brand-period">.</span></strong></span></a><button className="icon-button menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-controls="sidebar-navigation" aria-label={menuOpen ? 'Закрыть навигацию' : 'Открыть навигацию'}>{menuOpen ? <X size={22} /> : <Menu size={22} />}</button></div>
    <div className="sidebar-inner" id="sidebar-navigation"><nav aria-label="Основная навигация">{pages.filter(item => item.id !== 'operator' || user?.role === 'operator').map(({ id, title, Icon }) => <a key={id} href={`#/${id}`} onClick={() => setMenuOpen(false)} aria-current={page === id ? 'page' : undefined} className={page === id ? 'active' : ''}><Icon size={19} aria-hidden="true" /><span>{id === 'catalog' ? 'Каталог' : title}</span>{page === id && <ChevronRight className="nav-chevron" size={15} aria-hidden="true" />}</a>)}</nav>
    <div className="sidebar-bottom">{user ? <div className="account-panel"><div className="account-identity"><span className="avatar">{user.displayName.slice(0, 1).toLocaleUpperCase('ru')}</span><div><strong>{user.displayName}</strong><span title={user.email}>{user.email}</span></div></div><button className="logout-button" onClick={() => void logout()} disabled={loggingOut}><LogOut size={16} />{loggingOut ? 'Выходим…' : 'Выйти из аккаунта'}</button></div> : <div className="sidebar-guest"><button className="button sidebar-login" onClick={() => { setMenuOpen(false); setAuthMode('login'); }} disabled={!csrf || sessionLoading}>Войти в аккаунт <ArrowRight size={16} /></button></div>}</div></div></aside>
    <main id="main-content" className="main-content" tabIndex={-1}><header className="topbar"><div className="breadcrumb">Achievement Atlas <ChevronRight size={13} aria-hidden="true" /><span>{pageInfo.title}</span></div><div className="topbar-actions"><button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему'}>{theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}</button>{!user && <button className="text-button topbar-login" disabled={!csrf || sessionLoading} onClick={() => setAuthMode('login')}>Войти <ArrowRight size={15} /></button>}</div></header>
      <div className="page-content"><div className="page-heading"><div><h1>{pageInfo.title}</h1><p>{pageInfo.subtitle}</p></div>{user && loading && data && <span className="updating" role="status">Обновляем данные…</span>}</div>
        {sessionError && <ErrorNotice message={sessionError} retry={() => void initialize()} />}
        {healthError && <ErrorNotice message={`Не удалось получить состояние сервиса. ${healthError}`} retry={() => void loadHealth()} />}
        {error && <ErrorNotice message={error} retry={() => void refreshAll()} />}
        <div className="page-body">{content()}</div>
      </div>
    </main>{authMode && <AuthModal csrf={csrf} initialMode={authMode} onClose={() => setAuthMode(null)} onAuthenticated={session} />}
  </div>;
}
