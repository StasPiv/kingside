import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { MoveVisit } from '@kingside/shared';

/**
 * KS-4640 / KS-4641 / ADR-143 §7.3 / §7.6. Popover выбора момента
 * упоминания хода в записи лекции.
 *
 * Открывается из `LectureReplayPage` (через `AnalysisPage`) когда
 * клик по узлу Moves panel'и нашёл больше одного `MoveVisit`. Доска
 * уже переключилась на узел в момент клика — popover управляет
 * только seek'ом аудио.
 *
 * Поведение строк:
 *   - Сортировка — хронологическая (по `enteredAtMs` ASC). Гарантируется
 *     builder'ом индекса (`MoveTimestampIndex.visits` инвариант).
 *   - Метка «самое долгое» — у строки с максимальным `durationMs`;
 *     при ничьей выигрывает первая по времени (стабильная сортировка
 *     по `enteredAtMs`).
 *   - Клик по строке — `onSeek(visit.enteredAtMs)` + закрытие.
 *
 * Кнопка снизу «без перемотки звука» — просто закрывает popover.
 * Доска уже была переключена обработчиком до открытия — никакого
 * отдельного действия не требуется.
 *
 * Accessibility (ADR §7.6): закрытие по `Escape`, focus-trap не
 * делаем (popover лёгкий, кнопка close в правом верхнем углу).
 *
 * KS-4641 / договорённость с layout (KS-4642): все элементы
 * стилизуются через className, без inline-style. CSS живёт в слое
 * layout (`apps/web/src/styles/...`). `data-testid` атрибуты —
 * стабильный контракт для тестов / QA.
 */

export interface MoveTimestampsPopoverProps {
  visits: ReadonlyArray<MoveVisit>;
  /** Подпись хода (SAN или человекочитаемое). Опционально. */
  moveLabel?: string;
  onSeek: (atMs: number) => void;
  onClose: () => void;
}

function formatTimeMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDurationSec(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${sec.toString().padStart(2, '0')}`;
}

export function MoveTimestampsPopover({
  visits,
  moveLabel,
  onSeek,
  onClose,
}: MoveTimestampsPopoverProps) {
  const { t } = useTranslation();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Индекс «самой долгой» строки (для метки). При ничьей — первая
  // в хронологическом порядке.
  let longestIdx = -1;
  let longestMs = -1;
  for (let i = 0; i < visits.length; i++) {
    if (visits[i].durationMs > longestMs) {
      longestMs = visits[i].durationMs;
      longestIdx = i;
    }
  }

  return (
    <div
      className="move-timestamps-popover__overlay"
      data-testid="move-timestamps-popover-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="move-timestamps-popover"
        role="dialog"
        aria-modal="true"
        aria-label={t(
          'moveTimestamps.dialogAria',
          'Choose timestamp to seek audio',
        )}
        data-testid="move-timestamps-popover"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="move-timestamps-popover__header">
          <h3 className="move-timestamps-popover__title">
            {moveLabel
              ? t(
                  'moveTimestamps.titleWithMove',
                  'Trainer revisited this move ({{move}})',
                  { move: moveLabel },
                )
              : t('moveTimestamps.title', 'Trainer revisited this move')}
          </h3>
          <button
            type="button"
            className="move-timestamps-popover__close"
            onClick={onClose}
            data-testid="move-timestamps-popover-close"
            aria-label={t('common.close', 'Close')}
          >
            ×
          </button>
        </div>

        <ul
          className="move-timestamps-popover__list"
          role="listbox"
          data-testid="move-timestamps-popover-list"
        >
          {visits.map((v, i) => {
            const isLongest = i === longestIdx && visits.length > 1;
            return (
              <li
                key={`${v.enteredAtMs}-${i}`}
                className="move-timestamps-popover__row"
              >
                <button
                  type="button"
                  className={
                    'move-timestamps-popover__item' +
                    (isLongest ? ' move-timestamps-popover__item--longest' : '')
                  }
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onSeek(v.enteredAtMs);
                    onClose();
                  }}
                  data-testid="move-timestamps-popover-item"
                  data-entered-ms={v.enteredAtMs}
                  data-longest={isLongest ? 'true' : 'false'}
                >
                  <span className="move-timestamps-popover__time">
                    {formatTimeMs(v.enteredAtMs)}
                  </span>
                  <span className="move-timestamps-popover__duration">
                    {t(
                      'moveTimestamps.durationLabel',
                      'duration {{sec}}s',
                      { sec: formatDurationSec(v.durationMs) },
                    )}
                  </span>
                  {isLongest && (
                    <span
                      className="move-timestamps-popover__longest-tag"
                      data-testid="move-timestamps-popover-item-longest"
                    >
                      {t('moveTimestamps.longestTag', 'longest')}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="move-timestamps-popover__footer">
          <button
            type="button"
            className="move-timestamps-popover__no-seek"
            onClick={onClose}
            data-testid="move-timestamps-popover-no-seek"
          >
            {t(
              'moveTimestamps.noSeek',
              'Open position without seeking audio',
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
