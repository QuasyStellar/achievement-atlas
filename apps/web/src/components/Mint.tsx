import { useState, type FormEvent } from 'react';
import { ArrowRight, CheckCircle2, Clock3, ExternalLink, LoaderCircle, Send, TriangleAlert } from 'lucide-react';
import { errorText, request } from '../api';
import type { Health, MintJob, Reward } from '../types';
import { BadgeArt } from './BadgeArt';
import { ErrorNotice, Modal } from './UI';

export const statuses = {
  pending: { label: 'В очереди', description: 'Заявка принята. Транзакция ещё не отправлена.', Icon: Clock3 },
  submitted: { label: 'Отправлено в сеть', description: 'Ожидаем проверки транзакции и NFT в блокчейне.', Icon: Send },
  confirmed: { label: 'Подтверждено', description: 'Транзакция и NFT проверены в блокчейне.', Icon: CheckCircle2 },
  failed: { label: 'Ошибка выпуска', description: 'Выпуск не подтверждён.', Icon: TriangleAlert },
};
export function MintStatus({ mint }: { mint: MintJob }) {
  const status = statuses[mint.status];
  return <div className="mint-detail"><span className={`mint-status ${mint.status}`}><status.Icon size={15} aria-hidden="true" />{status.label}</span><p>{status.description}</p>
    <dl className="mint-facts"><div><dt>Получатель</dt><dd><code>{mint.recipient}</code></dd></div><div><dt>Заявка</dt><dd><code>{mint.id}</code></dd></div>
      {mint.transactionHash && <div><dt>Транзакция</dt><dd><a href={`https://testnet.tonviewer.com/transaction/${encodeURIComponent(mint.transactionHash)}`} target="_blank" rel="noopener noreferrer" className="address-link">{mint.transactionHash}<ExternalLink size={13} /></a></dd></div>}
      {mint.status === 'confirmed' && mint.itemAddress && <div><dt>NFT</dt><dd><a href={`https://testnet.tonviewer.com/${encodeURIComponent(mint.itemAddress)}`} target="_blank" rel="noopener noreferrer" className="address-link">{mint.itemAddress}<ExternalLink size={13} /></a></dd></div>}
      {mint.itemIndex !== null && <div><dt>Индекс NFT</dt><dd>{mint.itemIndex}</dd></div>}
    </dl>{mint.status === 'failed' && mint.error && <p className="mint-error">Ответ сервиса: {mint.error}</p>}</div>;
}
export function MintModal({ reward, health, csrf, onClose, onSubmitted }: { reward: Reward; health: Health | null; csrf: string; onClose: () => void; onSubmitted: (mint: MintJob) => Promise<void> }) {
  const [recipient, setRecipient] = useState(health?.chain.permission?.recipient ?? '');
  const [confirm, setConfirm] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const enabled = !!health?.chain.configured && !!health.chain.mintingEnabled;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (!recipient.trim()) { setError('Укажите адрес получателя.'); return; }
    if (!confirm) { setRecipient(recipient.trim()); setConfirm(true); return; }
    if (!accepted || !enabled || busy) return;
    setBusy(true);
    try {
      const result = await request<{ mint: MintJob }>(`/rewards/${encodeURIComponent(reward.unlockId)}/mint`, { method: 'POST', csrf, body: { recipient: recipient.trim() } });
      await onSubmitted(result.mint);
      onClose();
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  return <Modal title={confirm ? 'Проверьте адрес назначения' : 'Получить NFT'} onClose={() => { if (!busy) onClose(); }}><div className="mint-modal-reward"><BadgeArt seed={reward.achievementId} /><div><h3>{reward.title}</h3></div></div><form className="form-stack" onSubmit={submit}>
    {!confirm ? <><label>Адрес получателя<input name="recipient" value={recipient} onChange={event => setRecipient(event.target.value)} required maxLength={128} autoComplete="off" spellCheck={false} placeholder="EQ…, UQ… или 0:…" aria-describedby="recipient-hint" /></label><p className="field-hint" id="recipient-hint">Адрес кошелька TON, на который будет отправлен NFT.</p></> : <><div className="confirmation-address"><span>Награда будет направлена на адрес</span><code>{recipient}</code><button type="button" className="text-button" disabled={busy} onClick={() => { setConfirm(false); setAccepted(false); setError(''); }}>Изменить адрес</button></div><p className="body-note">После создания заявки изменить адрес нельзя.</p>{health?.chain.permission && <div className="confirmation-address"><span>TON testnet · один новый NFT · до {health.chain.permission.maxSpendTon} test TON вместе с комиссиями</span><span>Коллекция</span><code>{health.chain.collectionAddress}</code><span>Кошелёк отправителя</span><code>{health.chain.walletAddress}</code><p className="field-hint">Разрешён только указанный получатель. После одной заявки новые выпуски блокируются. Автоматического повтора нет.</p></div>}<label className="checkbox-label"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} required disabled={busy} /><span>Адрес проверен, отправить NFT на него.</span></label></>}
    {!enabled && <ErrorNotice message="Выпуск NFT сейчас отключён." />}{error && <ErrorNotice message={error} />}
    <button className="button primary full" type="submit" disabled={busy || !enabled || !csrf || (confirm && !accepted)}>{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}{busy ? 'Создаём заявку…' : confirm ? 'Подтвердить заявку' : 'Продолжить'}</button>
  </form></Modal>;
}
