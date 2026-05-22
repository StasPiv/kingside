import { useTranslation } from 'react-i18next';

import { readPgnHeader } from '../utils/forfeitTermination';

/**
 * KS-3258 (UX): плашка «Партия не игралась (forfeit)» вместо «No moves»
 * для PGN'ов с `[Termination "Unplayed"]` (forfeit/default/walkover).
 *
 * Рендерится в нейтральной палитре (не красный — это не ошибка, а
 * валидный исход партии). Сам result (`0-1` / `1-0`) показываем
 * подстрокой, если есть в PGN headers.
 *
 * Использование:
 *   {isForfeitGame(pgn, history.length)
 *     ? <ForfeitPlaceholder pgn={pgn} />
 *     : <p>{t('broadcastLive.noMovesYet', '…')}</p>}
 */
export interface ForfeitPlaceholderProps {
  /**
   * Raw PGN — нужен для извлечения result + termination для подсказки.
   * Альтернативно можно передать `headers` напрямую (см. ниже), если
   * PGN уже распарсен (AnalysisPage хранит только headers, не сам PGN).
   */
  pgn?: string | null | undefined;
  /**
   * KS-3258 follow-up: уже распарсенные PGN-headers. Имеет приоритет
   * над `pgn` если оба переданы. Используется в AnalysisPage, где
   * raw PGN не доступен после initial-parse.
   */
  headers?: Record<string, string> | null;
  /** Доп. CSS-класс (если callsite хочет интегрировать в свой layout). */
  className?: string;
  testId?: string;
}

export function ForfeitPlaceholder({
  pgn,
  headers,
  className,
  testId,
}: ForfeitPlaceholderProps) {
  const { t } = useTranslation();
  const termination = headers
    ? (headers.Termination ?? headers.termination ?? null)
    : pgn
      ? readPgnHeader(pgn, 'Termination')
      : null;
  const result = headers
    ? (headers.Result ?? headers.result ?? null)
    : pgn
      ? readPgnHeader(pgn, 'Result')
      : null;
  return (
    <div
      className={`forfeit-placeholder${className ? ' ' + className : ''}`}
      data-testid={testId ?? 'forfeit-placeholder'}
      data-termination={termination ?? ''}
      data-result={result ?? ''}
      role="status"
    >
      <span className="forfeit-placeholder__icon" aria-hidden="true">
        ⚑
      </span>
      <div className="forfeit-placeholder__text">
        <strong>{t('forfeit.title', 'Game not played (forfeit)')}</strong>
        {result && result !== '*' && (
          <span
            className="forfeit-placeholder__result"
            data-testid="forfeit-placeholder-result"
          >
            {t('forfeit.result', { defaultValue: 'Result: {{value}}', value: result })}
          </span>
        )}
        <span className="forfeit-placeholder__hint">
          {t(
            'forfeit.hint',
            'No moves were played — one of the players forfeited (no-show, walkover or rules infraction).',
          )}
        </span>
      </div>
    </div>
  );
}
