import type { NavigateFunction } from 'react-router-dom';

import { openAnalysis } from './openAnalysis';

/**
 * KS-2403 follow-up + KS-2603 (ADR-051 §4 B1): обёртка над общим
 * `openAnalysis` для legacy-вызовов из Archive/Broadcast (5 callsite'ов
 * по состоянию на KS-2603 — `BroadcastGamePage`, `BroadcastRoundPage`,
 * `BroadcastLiveGamePage`, `BroadcastStandings`, `LegacyStandings`).
 *
 * Подпись `(navigate, { pgn, title, state?, replace? })` сохранена как
 * было — не правим 5 мест. Новые callsite'ы (Workshop/Puzzle/Lobby —
 * B2..B5) идут напрямую в `openAnalysis` с поддержкой `existingId` и
 * пустого PGN.
 *
 * # Изменение поведения KS-2603
 *
 * До KS-2603 при ошибке POST `/analyses` обёртка делала fallback
 * `navigate('/analysis', state)` без id — это симптом из KS-2403,
 * который и чинит ADR-051. Теперь error-path: `alert(message)` (по
 * умолчанию) и НЕ navigate без id. Если backend временно недоступен,
 * пользователь остаётся на текущей странице с явным сообщением вместо
 * безымянного `/analysis`-URL'а с риском потери данных.
 */
export async function openAnalysisFromPgn(
  navigate: NavigateFunction,
  args: {
    pgn: string;
    title: string;
    /** Доп. поля state навигации (breadcrumb*, прочее). */
    state?: Record<string, unknown>;
    /** Переход через `replace`, а не push (например, для редиректа из
     *  legacy URL `/broadcasts/<t>/<r>/<g>` на `/analysis/<id>`). */
    replace?: boolean;
  },
): Promise<void> {
  await openAnalysis(navigate, {
    pgn: args.pgn,
    title: args.title,
    state: args.state,
    replace: args.replace,
  });
}
