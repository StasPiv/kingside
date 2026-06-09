/**
 * KS-4023 / ADR-122 §3.3, §4. Контракты позиционной аналитики партии:
 * `GamePositionalTrace` хранит для одной партии массив полуходов с
 * полным набором `PositionalSubterm` на каждом ply (источник —
 * Stockfish WASM, KS-3648 / ADR-107). Используется графиком динамики
 * метрик во вкладке Metrics страницы анализа.
 *
 * Версия формата задаётся отдельной константой `POSITIONAL_TRACE_VERSION`
 * — единый источник истины и для клиента (для проверки актуальности
 * локального кеша) и для сервера (для UPSERT-валидации).
 */
import type { PositionalSubterm } from './api-contracts.js';

/**
 * Снимок позиционных подкомпонент Stockfish на одном полуходе.
 *
 *   - `ply` — 0..N, монотонно возрастает без пропусков (см. валидатор
 *     на сервере, ADR-122 §3.1). `ply=0` — стартовая позиция партии.
 *   - `subterms` — точный набор записей из `eval json` (по `PositionalSubterm`
 *     контракту), без агрегации. Один `id` может встречаться многократно
 *     с разными `square`/`color` — это нормальная семантика SF Trace.
 *   - `phase` — степень эндшпильности позиции в попугаях SF (0..256).
 *     Опциональна: при `undefined` фронт считает фазу сам по позиции
 *     либо использует `mix=0.5` для tapered-агрегации.
 */
export interface PositionalTracePly {
  ply: number;
  subterms: PositionalSubterm[];
  phase?: number;
}

/**
 * Ответ `GET /games/:gameId/positional-trace?v=<sfVersion>` (см.
 * ADR-122 §3.1) и форма записи в БД `game_positional_traces`.
 *
 *   - `durationMs` — сколько занял расчёт у клиента, null если не
 *     прислан (для аналитики, не для авторизации).
 *   - `createdAt` / `updatedAt` — ISO-8601 UTC. UPSERT обновляет
 *     `updatedAt`, не трогая `createdAt`.
 */
export interface GamePositionalTraceDto {
  gameId: string;
  sfVersion: string;
  plies: PositionalTracePly[];
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Тело `POST /games/:gameId/positional-trace`.
 *
 *   - `sfVersion` — строго совпадает с `POSITIONAL_TRACE_VERSION` на
 *     стороне сервера, иначе обработчик отвечает 400
 *     `sf_version_mismatch`.
 *   - `plies` — непустой массив с монотонно возрастающим `ply`. Размер
 *     итогового JSON ≤ 256 КБ (валидатор серверной стороны, ADR-122
 *     §3.1).
 *   - `durationMs` — клиентская подсказка, опциональна.
 */
export interface PositionalTraceUpsertDto {
  sfVersion: string;
  plies: PositionalTracePly[];
  durationMs?: number;
}

/**
 * Коды ошибок (соответствуют payload `{ error: <code>, ... }` от
 * сервера на 4xx ответах).
 *
 *   - `positional_trace_not_found` — `GET` для несуществующей записи
 *     либо запись существует, но `sfVersion` в БД отличается от `v`
 *     из query — клиент трактует как «кеш устарел», запускает расчёт.
 *   - `sf_version_mismatch` — `POST` с `sfVersion`, отличной от
 *     серверной константы. Тело может содержать `{ expected, got }`.
 *   - `positional_trace_too_large` — `POST` с payload > 256 КБ.
 *   - `positional_trace_invalid` — DTO не прошёл валидацию
 *     (немонотонный `ply`, value за пределами разумного диапазона
 *     и т. п.).
 */
export type PositionalTraceErrorCode =
  | 'positional_trace_not_found'
  | 'sf_version_mismatch'
  | 'positional_trace_too_large'
  | 'positional_trace_invalid';

/**
 * Единый источник истины для версии формата трассы. Меняется при:
 *   - изменении набора `PositionalSubtermId`;
 *   - правках парсера `evalTrace`;
 *   - переходе на новую версию Stockfish WASM, дающую иные числа.
 *
 * Клиент шлёт это значение в `GET` query и `POST` body. Сервер хранит
 * вместе с записью; при несовпадении — `GET` отдаёт 404, `POST` — 400.
 *
 * `sf18-trace-v2` — текущая версия (ADR-122 §3.2): Stockfish 18 lite
 * + расширенный набор per-square записей для threat-подкомпонент
 * (KS-4017).
 */
export const POSITIONAL_TRACE_VERSION = 'sf18-trace-v2';

/**
 * Серверный лимит на размер тела `POST` (см. ADR-122 §3.1, §4).
 * Дублируется в константу, чтобы фронт мог заранее предупредить
 * пользователя без round-trip'а.
 */
export const POSITIONAL_TRACE_MAX_BODY_BYTES = 256 * 1024;

/**
 * Диапазон допустимых значений `value_mg`/`value_eg` в subterms.
 * За пределами — DTO-валидатор отвечает 400 `positional_trace_invalid`.
 * Пешечная-cp в нашем формате обычно лежит в [-15, 15]; ±20 — запас на
 * редкие пики (например, `king_danger` после ошибочного раскрытия).
 */
export const POSITIONAL_TRACE_VALUE_LIMIT = 20;
