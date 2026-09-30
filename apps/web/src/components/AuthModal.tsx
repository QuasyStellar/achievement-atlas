import { useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { errorText, request } from '../api';
import type { User } from '../types';
import { ErrorNotice, Modal } from './UI';

export function AuthModal({ csrf, initialMode, onClose, onAuthenticated }: { csrf: string; initialMode: 'login' | 'register'; onClose: () => void; onAuthenticated: () => Promise<void> }) {
  const [mode, setMode] = useState(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      await request<{ user: User }>(`/auth/${mode}`, { method: 'POST', csrf, body: { email: String(form.get('email')).trim(), password: String(form.get('password')), ...(mode === 'register' ? { displayName: String(form.get('displayName')).trim() } : {}) } });
      await onAuthenticated();
      onClose();
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  return <Modal title={mode === 'login' ? 'Вход' : 'Регистрация игрока'} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit} className="form-stack">
      {mode === 'register' && <label>Имя игрока<input name="displayName" autoComplete="nickname" required maxLength={80} disabled={busy} /></label>}
      <label>Электронная почта<input name="email" type="email" autoComplete="email" required maxLength={254} disabled={busy} placeholder="you@example.com" /></label>
      <label>Пароль<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 8 : undefined} maxLength={128} disabled={busy} aria-describedby={mode === 'register' ? 'password-hint' : undefined} /></label>
      {mode === 'register' && <p className="field-hint" id="password-hint">Не менее 8 символов.</p>}
      {!csrf && <ErrorNotice message="Сессия не инициализирована. Закройте окно и повторите подключение к сервису." />}
      {error && <ErrorNotice message={error} />}
      <button className="button primary full" type="submit" disabled={busy || !csrf}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}{busy ? 'Подождите…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
    </form>
    <div className="auth-switch">{mode === 'login' ? 'Ещё нет аккаунта?' : 'Уже зарегистрированы?'} <button className="text-button" disabled={busy} onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Зарегистрироваться' : 'Войти'}</button></div>
  </Modal>;
}
