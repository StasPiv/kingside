/**
 * Парсер `Broadcast.standingsUrl` (KS-1735, ADR-023 §2.2.2 / §5.4).
 *
 * Чистая функция — без внешних зависимостей, тестируется отдельно от
 * `BroadcastSyncService`. Используется в `upsertBroadcast` для извлечения
 * `chess_results_tournament_id` и инкремента метрики
 * `crosstable_coverage_total{status}` (matched | unsupported | missing).
 *
 * `matched`     — URL ведёт на chess-results.com (включая s1/s2/s3
 *                 субдомены), id извлечён.
 * `unsupported` — URL есть, но это не chess-results (например,
 *                 `ergebnisdienst.schachbund.de`, ECU, ручной URL).
 *                 Дополнительно публикуем `host` отдельной меткой
 *                 (`crosstable_unsupported_source_total{host}`) — чтобы
 *                 видеть на dashboard, какие сторонние сайты популярны и
 *                 кандидаты для будущих парсеров.
 * `missing`     — URL пустой/null/whitespace. Lichess просто не отдал
 *                 standings для этого турнира.
 */

export type CoverageStatus = 'matched' | 'unsupported' | 'missing';

export interface ExtractResult {
  /** chess-results tournament-id (только цифры, например "1394105"). null для unsupported/missing. */
  tournamentId: string | null;
  status: CoverageStatus;
  /**
   * Hostname для `unsupported` (lower-case, без `www.`-префикса) — пишется в
   * метрику `crosstable_unsupported_source_total{host}`. null для остальных
   * статусов.
   */
  host: string | null;
}

/**
 * Hostname считается chess-results-семьёй, если он `chess-results.com` ИЛИ
 * заканчивается на `.chess-results.com` (s1/s2/s3 субдомены, на которые
 * сайт балансировкой 302-редиректит). Cравнение case-insensitive.
 */
function isChessResultsHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'chess-results.com' || h.endsWith('.chess-results.com');
}

/**
 * Нормализация host для метрики: lower-case, опциональный `www.`-префикс
 * убран. Это снижает кардинальность: `www.example.com` и `example.com`
 * лягут в одну ячейку.
 */
function normalizeHost(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.startsWith('www.') ? h.slice(4) : h;
}

/**
 * Извлекает `tnr<ID>` из path. chess-results URLs имеют форму
 * `/tnrID.aspx` (опционально с query: `?lan=1&art=4`).
 */
const TNR_PATH_RE = /^\/tnr(\d+)\.aspx$/i;

export function extractChessResultsTournamentId(
  rawUrl: string | null | undefined,
): ExtractResult {
  const trimmed = rawUrl?.trim() ?? '';
  if (trimmed === '') {
    return { tournamentId: null, status: 'missing', host: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Не валидный URL — считаем missing, не unsupported (нет hostname'а
    // для разбора).
    return { tournamentId: null, status: 'missing', host: null };
  }

  if (!isChessResultsHost(parsed.hostname)) {
    return {
      tournamentId: null,
      status: 'unsupported',
      host: normalizeHost(parsed.hostname),
    };
  }

  const m = TNR_PATH_RE.exec(parsed.pathname);
  if (!m) {
    // chess-results host, но path не tnrID.aspx — например главная страница
    // или другой раздел. Считаем missing — id не извлечён, но для метрики
    // это не «другой источник», а просто «нет id». Hostname метрики не
    // публикуем (он chess-results-овский, dashboard засорится сам собой).
    return { tournamentId: null, status: 'missing', host: null };
  }

  return { tournamentId: m[1], status: 'matched', host: null };
}
