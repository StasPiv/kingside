/**
 * KS-2066 (F0/ADR-033 §2): HTTP-клиент модуля «Архив партий».
 *
 * Цель F0 — собрать в одном месте все обращения к archive-service, которые
 * понадобятся в F1–F4 (lobby, список партий, профиль игрока, страница
 * партии). Типы — единственный источник истины из `@kingside/shared`
 * (B0/KS-2062), здесь только построение URL и дёргание `fetch`.
 *
 * Архив-сервис вынесен на отдельный backend (`archive-service`,
 * ADR-018 §2.7), его base URL берётся из `ARCHIVE_URL`. Маппинг путей,
 * описанный в ADR-033 как `/api/archive/games`, на этом сервисе
 * физически висит на `/games` (т.к. весь сервис «и есть» архив).
 *
 * Авторизация — Bearer-токен из `localStorage` (паттерн повторяет
 * `useArchiveGamesByPosition`/`useArchiveTree`, не используем общий
 * `api.ts` потому что у него фиксированный `API_URL`).
 */

import type {
  ArchiveEventSearchResponse,
  ArchiveGameDetail,
  ArchiveGamesByPositionRequest,
  ArchiveGamesByPositionResponse,
  ArchiveGamesRequest,
  ArchiveGamesResponse,
  ArchivePlayerGamesRequest,
  ArchivePlayerGamesResponse,
  ArchivePlayerProfileResponse,
  ArchivePlayerSearchResponse,
} from '@kingside/shared';
import { ARCHIVE_URL } from '../config/archiveUrl';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token =
      typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    /* ignore — happy-dom без localStorage в SSR-тестах */
  }
  return headers;
}

async function archiveGet<T>(
  path: string,
  params?: URLSearchParams,
  signal?: AbortSignal,
): Promise<T> {
  const qs = params && params.toString().length > 0 ? `?${params.toString()}` : '';
  const res = await fetch(`${ARCHIVE_URL}${path}${qs}`, {
    method: 'GET',
    headers: authHeaders(),
    // KS-2149: AbortSignal — отменяем in-flight запросы при rapid
    // filter change / unmount, чтобы устаревшие ответы не аппендились
    // в новый список через race condition.
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `Archive request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Кладёт пары [key, value] в `URLSearchParams`, пропуская `undefined`/`null`.
 * Числа конвертируются в строку. Используется обёртками ниже, чтобы каждая
 * не повторяла одну и ту же ветвистую сериализацию фильтров.
 */
function appendDefined(
  params: URLSearchParams,
  pairs: Array<[string, string | number | undefined | null]>,
): void {
  for (const [k, v] of pairs) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    params.set(k, String(v));
  }
}

// ─── Players ─────────────────────────────────────────────────────────

/**
 * GET /players/search?q=... — autocomplete и поиск игроков по имени.
 *
 * Используется на лобби (F1) и списке партий (F2) для выбора игрока в
 * фильтре. `limit` — page size (бэкенд по умолчанию 10).
 */
export function searchArchivePlayers(
  q: string,
  limit?: number,
): Promise<ArchivePlayerSearchResponse> {
  const params = new URLSearchParams();
  appendDefined(params, [
    ['q', q],
    ['limit', limit],
  ]);
  // KS-2080: backend B3 (KS-2065) реализовал autocomplete на
  // `/players/search` (см. ADR-033 §6.3). Старый путь `/players?q=`
  // отдавал 404 — отсюда «Не удалось загрузить подсказки» на лобби.
  return archiveGet<ArchivePlayerSearchResponse>('/players/search', params);
}

/**
 * GET /players/:slug — карточка игрока (имя, gamesCount, peakElo, по цвету,
 * по результату). Источник профильной страницы (F3).
 */
export function getArchivePlayerProfile(
  slug: string,
): Promise<ArchivePlayerProfileResponse> {
  return archiveGet<ArchivePlayerProfileResponse>(
    `/players/${encodeURIComponent(slug)}`,
  );
}

/**
 * GET /players/:slug/games — партии игрока с фильтрами.
 *
 * `slug` — path-параметр; в `ArchivePlayerGamesRequest` он также есть для
 * типизации клиента, поэтому передаётся отдельным аргументом, а не внутри
 * `filters`.
 */
export function getArchivePlayerGames(
  slug: string,
  filters: Omit<ArchivePlayerGamesRequest, 'slug'> = {},
): Promise<ArchivePlayerGamesResponse> {
  const params = new URLSearchParams();
  appendDefined(params, [
    ['color', filters.color && filters.color !== 'any' ? filters.color : undefined],
    ['result', filters.result],
    ['eco', filters.eco],
    ['event', filters.event],
    ['minElo', filters.minElo],
    ['since', filters.since],
    ['until', filters.until],
    ['minPly', filters.minPly],
    ['maxPly', filters.maxPly],
    ['sort', filters.sort],
    ['limit', filters.limit],
    ['offset', filters.offset],
  ]);
  // KS-2115: массив контролей сериализуем дубликатами через `append`,
  // одиночное значение — обычным `append` (на бэке `?timeControlCategory=...`
  // парсится одинаково в обоих случаях).
  if (Array.isArray(filters.timeControlCategory)) {
    for (const cat of filters.timeControlCategory) {
      params.append('timeControlCategory', cat);
    }
  } else if (filters.timeControlCategory) {
    params.append('timeControlCategory', filters.timeControlCategory);
  }
  return archiveGet<ArchivePlayerGamesResponse>(
    `/players/${encodeURIComponent(slug)}/games`,
    params,
  );
}

// ─── Events ──────────────────────────────────────────────────────────

/**
 * GET /events/search?q=... — autocomplete и поиск турниров/событий по названию.
 * Используется на лобби (F1) и в фильтре «Событие» на списке партий (F2).
 */
export function searchArchiveEvents(
  q: string,
  limit?: number,
): Promise<ArchiveEventSearchResponse> {
  const params = new URLSearchParams();
  appendDefined(params, [
    ['q', q],
    ['limit', limit],
  ]);
  // KS-2080: backend в B3 — на `/events/search` (ADR-033 §6.3).
  return archiveGet<ArchiveEventSearchResponse>('/events/search', params);
}

// ─── Games (metadata list & single) ─────────────────────────────────

/**
 * GET /games — список партий с metadata-фильтрами (без FEN-привязки).
 * Не путать с `/games/by-position` — там поиск по конкретной позиции
 * (отдельный экран `/archive/by-position`, см. `ArchiveGamesByPositionPage`).
 */
export function getArchiveGamesMetadata(
  filters: ArchiveGamesRequest = {},
  signal?: AbortSignal,
): Promise<ArchiveGamesResponse> {
  const params = new URLSearchParams();
  // KS-2084: `player` теперь принимает массив (KS-2081 на бэке).
  // Сериализуем КАЖДОГО игрока через `params.append('player', name)`,
  // чтобы получился `?player=A&player=B` (Express парсит дубликаты
  // query-параметра как массив). `params.set` тут НЕ подходит — он
  // перезаписал бы значение и уехал бы только последний игрок.
  if (Array.isArray(filters.player)) {
    for (const name of filters.player) {
      const trimmed = name.trim();
      if (trimmed.length > 0) params.append('player', trimmed);
    }
  } else if (typeof filters.player === 'string' && filters.player.trim().length > 0) {
    params.set('player', filters.player.trim());
  }
  // KS-2115: массив timeControlCategory сериализуем дубликатами через
  // `append` (на бэке Express собирает их в массив, OR-семантика).
  if (Array.isArray(filters.timeControlCategory)) {
    for (const cat of filters.timeControlCategory) {
      params.append('timeControlCategory', cat);
    }
  } else if (filters.timeControlCategory) {
    params.append('timeControlCategory', filters.timeControlCategory);
  }
  appendDefined(params, [
    ['fen', filters.fen],
    ['move', filters.move],
    ['white', filters.white],
    ['black', filters.black],
    ['eco', filters.eco],
    ['minElo', filters.minElo],
    ['result', filters.result],
    ['since', filters.since],
    ['until', filters.until],
    ['event', filters.event],
    ['minPly', filters.minPly],
    ['maxPly', filters.maxPly],
    ['sort', filters.sort],
    ['limit', filters.limit],
    ['offset', filters.offset],
    ['cursor', filters.cursor],
  ]);
  return archiveGet<ArchiveGamesResponse>('/games', params, signal);
}

/**
 * GET /games/by-position — список партий, где встречалась переданная позиция.
 *
 * KS-3087: единственный эндпоинт, который действительно фильтрует партии
 * по FEN (использует `archive_position_stats`-индекс, keyset cursor).
 * `/games` параметр `fen` принимает в DTO, но игнорирует в сервисе
 * (KS-1581 §4.2 deferred → KS-3088 backend параллельно перевешивает на 400),
 * поэтому фронт обязан звать именно этот путь, когда фильтр FEN активен.
 *
 * Набор поддерживаемых фильтров уже` ArchiveGamesRequest` — нет `event`,
 * `until`, `minPly`, `maxPly`, `timeControlCategory`. Если пользователь
 * выставил FEN и эти фильтры, они **молча игнорируются** (follow-up
 * backend-задача — расширить эндпоинт). UI оставляет их видимыми, чтобы
 * пользователь мог снять FEN и вернуться в общий список с этими фильтрами.
 */
export function getArchiveGamesByPosition(
  filters: ArchiveGamesByPositionRequest,
  signal?: AbortSignal,
): Promise<ArchiveGamesByPositionResponse> {
  const params = new URLSearchParams();
  // FEN — обязательный.
  params.set('fen', filters.fen);
  // KS-2081 / KS-2084: `player` поддерживает массив (`?player=A&player=B`,
  // OR на бэке). Дубликатный append, как и в `/games`.
  if (Array.isArray(filters.player)) {
    for (const name of filters.player) {
      const trimmed = name.trim();
      if (trimmed.length > 0) params.append('player', trimmed);
    }
  } else if (
    typeof filters.player === 'string' &&
    filters.player.trim().length > 0
  ) {
    params.set('player', filters.player.trim());
  }
  appendDefined(params, [
    ['bucket', filters.bucket],
    ['sort', filters.sort],
    ['cursor', filters.cursor],
    ['limit', filters.limit],
    ['minElo', filters.minElo],
    ['since', filters.since],
    ['result', filters.result],
    ['color', filters.color],
    ['move', filters.move],
    ['eco', filters.eco],
  ]);
  return archiveGet<ArchiveGamesByPositionResponse>(
    '/games/by-position',
    params,
    signal,
  );
}

/**
 * GET /games/:id — одна архивная партия с PGN. Источник страницы F4.
 */
export function getArchiveGameById(id: string): Promise<ArchiveGameDetail> {
  return archiveGet<ArchiveGameDetail>(`/games/${encodeURIComponent(id)}`);
}

// Экспорт через объект — для удобства мокирования в тестах
// (`vi.mock('./archive', ...)`).
export const archiveApi = {
  searchArchivePlayers,
  getArchivePlayerProfile,
  getArchivePlayerGames,
  searchArchiveEvents,
  getArchiveGamesMetadata,
  getArchiveGamesByPosition,
  getArchiveGameById,
};
