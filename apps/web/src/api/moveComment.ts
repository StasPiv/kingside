/**
 * KS-3712. Клиент `POST /analyses/review/move-comment` — комментарий
 * к одному ходу партии. Пользователь явно подтвердил формат: два
 * снимка позиции (до и после хода) в том же виде, что у
 * `position-comment` (`fen` + список факторов), плюс описание самого
 * хода и язык ответа.
 *
 * Контракт обработчика (KS-3711, kingside-api:388):
 *   Запрос:  { move, before, after, language }
 *   Ответ:   { comment, highlights?, arrows? }
 *
 * Запросы — атомарные, по одному на ход. На партию 30 ходов = 30
 * запросов; лимит бэкенда 60/мин на пользователя (KS-3711). Очередь
 * формирует `useGameReview`, этот клиент знает только об одной
 * единице работы.
 */
import type { PositionalSubterm } from '@kingside/shared';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export type MoveClassification =
  | 'best'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

export interface MoveCommentMoveField {
  san: string;
  uci: string;
  /** Тип взятой фигуры (`p`/`n`/`b`/`r`/`q`) или null. */
  capture: 'p' | 'n' | 'b' | 'r' | 'q' | null;
  check: boolean;
  /** Число полуходов до мата (от состояния перед ходом). null — мата нет. */
  mate: number | null;
  castling: 'O-O' | 'O-O-O' | null;
  promotion: 'q' | 'r' | 'b' | 'n' | null;
  classification: MoveClassification;
}

/**
 * Факторы позиции в формате `position-comment`. Помимо подкомпонент
 * `evalTrace` (`PositionalSubterm`) допускаются произвольные «engine»-
 * записи (`sf18_eval`, `sf18_pv`), у которых нет фиксированной формы.
 * Бэкенд читает массив как произвольный JSON и передаёт модели.
 */
export type MoveCommentFactor = PositionalSubterm | Record<string, unknown>;

export interface MoveCommentSnapshot {
  fen: string;
  factors: MoveCommentFactor[];
}

export interface MoveCommentRequest {
  move: MoveCommentMoveField;
  before: MoveCommentSnapshot;
  after: MoveCommentSnapshot;
  language?: 'ru' | 'en';
}

export interface MoveCommentResponse {
  comment: string;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  try {
    const token =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem('token')
        : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    /* localStorage недоступен в SSR-тестах */
  }
  return headers;
}

function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  if (e instanceof Error && e.name === 'AbortError') return true;
  return false;
}

/**
 * Один POST `/analyses/review/move-comment`. Возвращает текст
 * комментария (пустую строку при любой нефатальной ошибке —
 * `useGameReview` сам решит, поднимать ли warning). `AbortError`
 * пробрасывается, чтобы хук завершился `status='cancelled'`.
 */
export async function postMoveComment(
  body: MoveCommentRequest,
  signal?: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/analyses/review/move-comment`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    return '';
  }

  if (!res.ok) return '';

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return '';
  }

  const comment = (data as { comment?: unknown } | null)?.comment;
  return typeof comment === 'string' ? comment : '';
}
