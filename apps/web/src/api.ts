export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public requestId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, options: { method?: 'POST'; body?: unknown; csrf?: string; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET', credentials: 'same-origin', signal: options.signal ?? AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json', ...(options.method ? { 'Content-Type': 'application/json', 'X-CSRF-Token': options.csrf ?? '' } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('NETWORK_ERROR', 'Не удалось связаться с сервером. Проверьте соединение и попробуйте ещё раз.', 0);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new ApiError('INVALID_RESPONSE', 'Сервер вернул неожиданный ответ. Попробуйте обновить страницу.', response.status); }
  if (!response.ok) {
    const details = (data as { error?: { code?: string; message?: string; requestId?: string } }).error;
    throw new ApiError(details?.code ?? 'REQUEST_FAILED', details?.message ?? 'Запрос не выполнен.', response.status, details?.requestId);
  }
  return data as T;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      INVALID_CREDENTIALS: 'Неверная почта или пароль. Проверьте данные и попробуйте снова.',
      EMAIL_EXISTS: 'Аккаунт с этой почтой уже существует. Войдите или используйте другой адрес.',
      INVALID_RECIPIENT: 'Адрес не распознан. Проверьте адрес кошелька TON.',
      RECIPIENT_CONFLICT: 'Для этого достижения уже создана заявка с другим адресом.',
      CSRF_INVALID: 'Сессия изменилась. Закройте окно, обновите страницу и повторите действие.',
      OPERATOR_REQUIRED: 'Этот раздел доступен только оператору.',
      DEMO_DISABLED: 'Демонстрационный режим выключен. Симуляция игровых событий недоступна.',
      REWARD_NOT_FOUND: 'Достижение не найдено. Обновите страницу.',
      MINT_LIMIT_REACHED: 'Лимит выпуска NFT на этом стенде исчерпан.',
      PLAYER_NOT_FOUND: 'Игрок не найден. Обновите список пользователей.',
      COUNTER_LIMIT: 'Достигнут предел игрового счётчика.',
    };
    if (messages[error.code]) return messages[error.code];
    if (error.code === 'INVALID_PAYLOAD') return `${error.message}.`;
    if (error.status === 401) return 'Не удалось войти или сессия завершилась. Проверьте данные и войдите снова.';
    if (error.status === 403) return 'Действие недоступно для этой сессии. Обновите страницу или проверьте права доступа.';
    if (error.status === 409) return 'Возник конфликт: адрес или данные уже сохранены. Обновите список и проверьте существующую заявку.';
    if (error.status === 429) return 'Слишком много запросов. Подождите немного и попробуйте снова.';
    if (error.status === 503) return 'Выпуск NFT сейчас недоступен.';
    if (error.code === 'NETWORK_ERROR' || error.code === 'INVALID_RESPONSE') return error.message;
    if (error.status === 400) return `Проверьте введённые данные. ${error.message}`;
    if (error.status >= 500) return 'Сервис временно недоступен. Попробуйте повторить запрос позже.';
    return error.message;
  }
  return 'Не удалось выполнить действие. Попробуйте ещё раз.';
}
