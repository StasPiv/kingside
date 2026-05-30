/**
 * KS-3488 (ADR-088 V2 §15 F1). Форма настроек прогрессивной сложности
 * для blind-board:
 *   - counter-selector `startPieces` (Q/R/B/N) с квотами и потолком
 *     суммарного числа фигур (maxTotal);
 *   - sortable `addOrder` через up/down кнопки — каждая позиция
 *     выбирает тип фигуры из доступных квот, можно удалять/добавлять;
 *   - select `memorizeTimeSec` из `BLIND_BOARD_LIMITS.memorizeOptions`.
 *
 * onChange всегда отдаёт «текущее» состояние формы — даже если
 * локально невалидно. Caller (BlindBoardLandingPage) сам решает
 * disabled-state кнопки «Начать» через `validateBlindBoardConfig`.
 * Так UI «не зажёвывает» промежуточные правки (например,
 * пользователь временно перешёл за квоту, но мы блокируем дальнейшие
 * `+`, не откатываем введённое).
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BLIND_BOARD_LIMITS,
  type BlindBoardConfig,
  type BlindBoardPieceType,
} from '@kingside/shared';

import {
  countByType,
  remainingCapacity,
  remainingQuota,
} from './blindBoardConfigValidation';

const PIECE_TYPES: BlindBoardPieceType[] = ['Q', 'R', 'B', 'N'];

export interface BlindBoardConfigFormProps {
  value: BlindBoardConfig;
  onChange: (next: BlindBoardConfig) => void;
  disabled?: boolean;
}

export function BlindBoardConfigForm({
  value,
  onChange,
  disabled = false,
}: BlindBoardConfigFormProps) {
  const { t } = useTranslation();
  const startCounts = countByType(value.startPieces);
  const capacity = remainingCapacity(value);

  const incStart = useCallback(
    (type: BlindBoardPieceType) => {
      if (disabled) return;
      // Лимиты: квота по типу + общая ёмкость доски.
      if (remainingQuota(value, type) <= 0) return;
      if (capacity <= 0) return;
      onChange({
        ...value,
        startPieces: [...value.startPieces, type],
      });
    },
    [value, capacity, disabled, onChange],
  );

  const decStart = useCallback(
    (type: BlindBoardPieceType) => {
      if (disabled) return;
      const idx = value.startPieces.lastIndexOf(type);
      if (idx === -1) return;
      const next = [...value.startPieces];
      next.splice(idx, 1);
      onChange({ ...value, startPieces: next });
    },
    [value, disabled, onChange],
  );

  const addAddOrder = useCallback(
    (type: BlindBoardPieceType) => {
      if (disabled) return;
      if (remainingQuota(value, type) <= 0) return;
      if (capacity <= 0) return;
      onChange({ ...value, addOrder: [...value.addOrder, type] });
    },
    [value, capacity, disabled, onChange],
  );

  const removeAddOrderAt = useCallback(
    (idx: number) => {
      if (disabled) return;
      const next = [...value.addOrder];
      next.splice(idx, 1);
      onChange({ ...value, addOrder: next });
    },
    [value, disabled, onChange],
  );

  const moveAddOrderUp = useCallback(
    (idx: number) => {
      if (disabled || idx <= 0) return;
      const next = [...value.addOrder];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      onChange({ ...value, addOrder: next });
    },
    [value, disabled, onChange],
  );

  const moveAddOrderDown = useCallback(
    (idx: number) => {
      if (disabled || idx >= value.addOrder.length - 1) return;
      const next = [...value.addOrder];
      [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
      onChange({ ...value, addOrder: next });
    },
    [value, disabled, onChange],
  );

  const setMemorize = useCallback(
    (sec: number) => {
      if (disabled) return;
      onChange({ ...value, memorizeTimeSec: sec });
    },
    [value, disabled, onChange],
  );

  return (
    <div
      className="blind-board-config-form"
      data-testid="blind-board-config-form"
    >
      {/* ── Стартовый набор (counter-selector) ──────────────────── */}
      <section
        className="blind-board-config-form__section"
        data-testid="blind-board-config-start-section"
      >
        <h3 className="blind-board-config-form__section-title">
          {t('blindBoard.config.startPiecesTitle', 'Starting pieces')}
        </h3>
        <p
          className="blind-board-config-form__section-hint"
          data-testid="blind-board-config-start-hint"
        >
          {t(
            'blindBoard.config.startPiecesHint',
            'Choose pieces shown during the memorize phase. 3–7 total; quotas: Q≤1, R≤2, B≤2, N≤2.',
          )}
        </p>
        <div className="blind-board-config-form__counters">
          {PIECE_TYPES.map((type) => {
            const count = startCounts[type];
            const quotaLeft = remainingQuota(value, type);
            const canInc = !disabled && quotaLeft > 0 && capacity > 0;
            const canDec = !disabled && count > 0;
            return (
              <div
                key={type}
                className="blind-board-config-form__counter"
                data-testid={`blind-board-config-start-counter-${type}`}
                data-count={count}
              >
                <span className="blind-board-config-form__counter-label">
                  {t(`blindBoard.piece.${type}`, type)}
                </span>
                <div className="blind-board-config-form__counter-controls">
                  <button
                    type="button"
                    className="blind-board-config-form__counter-btn"
                    data-testid={`blind-board-config-start-dec-${type}`}
                    disabled={!canDec}
                    onClick={() => decStart(type)}
                    aria-label={t(
                      'blindBoard.config.decreaseAria',
                      'Decrease {{type}}',
                      { type },
                    )}
                  >
                    −
                  </button>
                  <span
                    className="blind-board-config-form__counter-value"
                    data-testid={`blind-board-config-start-value-${type}`}
                  >
                    {count}
                  </span>
                  <button
                    type="button"
                    className="blind-board-config-form__counter-btn"
                    data-testid={`blind-board-config-start-inc-${type}`}
                    disabled={!canInc}
                    onClick={() => incStart(type)}
                    aria-label={t(
                      'blindBoard.config.increaseAria',
                      'Increase {{type}}',
                      { type },
                    )}
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <p
          className="blind-board-config-form__capacity"
          data-testid="blind-board-config-capacity"
        >
          {t(
            'blindBoard.config.capacity',
            '{{used}} of {{max}} pieces used (start + add order)',
            {
              used:
                value.startPieces.length + value.addOrder.length,
              max: BLIND_BOARD_LIMITS.maxTotal,
            },
          )}
        </p>
      </section>

      {/* ── Очередь добавления (sortable) ───────────────────────── */}
      <section
        className="blind-board-config-form__section"
        data-testid="blind-board-config-add-section"
      >
        <h3 className="blind-board-config-form__section-title">
          {t('blindBoard.config.addOrderTitle', 'Add order (level-ups)')}
        </h3>
        <p
          className="blind-board-config-form__section-hint"
          data-testid="blind-board-config-add-hint"
        >
          {t(
            'blindBoard.config.addOrderHint',
            'Each entry adds one piece to the board on level-up (streak % 10).',
          )}
        </p>
        {value.addOrder.length === 0 && (
          <p
            className="blind-board-config-form__empty"
            data-testid="blind-board-config-add-empty"
          >
            {t(
              'blindBoard.config.addOrderEmpty',
              'No add-order entries — no level-ups will happen.',
            )}
          </p>
        )}
        <ol className="blind-board-config-form__add-list" data-testid="blind-board-config-add-list">
          {value.addOrder.map((type, idx) => (
            <li
              key={`${idx}-${type}`}
              className="blind-board-config-form__add-item"
              data-testid={`blind-board-config-add-item-${idx}`}
              data-piece={type}
            >
              <span className="blind-board-config-form__add-level">
                L{idx + 2}
              </span>
              <span className="blind-board-config-form__add-piece">
                {t(`blindBoard.piece.${type}`, type)}
              </span>
              <div className="blind-board-config-form__add-actions">
                <button
                  type="button"
                  className="blind-board-config-form__add-btn"
                  data-testid={`blind-board-config-add-up-${idx}`}
                  disabled={disabled || idx === 0}
                  onClick={() => moveAddOrderUp(idx)}
                  aria-label={t('blindBoard.config.moveUpAria', 'Move up')}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="blind-board-config-form__add-btn"
                  data-testid={`blind-board-config-add-down-${idx}`}
                  disabled={disabled || idx === value.addOrder.length - 1}
                  onClick={() => moveAddOrderDown(idx)}
                  aria-label={t('blindBoard.config.moveDownAria', 'Move down')}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="blind-board-config-form__add-btn blind-board-config-form__add-btn--remove"
                  data-testid={`blind-board-config-add-remove-${idx}`}
                  disabled={disabled}
                  onClick={() => removeAddOrderAt(idx)}
                  aria-label={t(
                    'blindBoard.config.removeAddAria',
                    'Remove entry',
                  )}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>
        <div
          className="blind-board-config-form__add-add"
          data-testid="blind-board-config-add-add"
        >
          <span className="blind-board-config-form__add-add-label">
            {t('blindBoard.config.addOrderAddLabel', 'Add piece:')}
          </span>
          {PIECE_TYPES.map((type) => {
            const canAdd =
              !disabled && remainingQuota(value, type) > 0 && capacity > 0;
            return (
              <button
                key={type}
                type="button"
                className="blind-board-config-form__add-add-btn"
                data-testid={`blind-board-config-add-add-${type}`}
                disabled={!canAdd}
                onClick={() => addAddOrder(type)}
              >
                + {t(`blindBoard.piece.${type}`, type)}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Время на запоминание ───────────────────────────────── */}
      <section
        className="blind-board-config-form__section"
        data-testid="blind-board-config-time-section"
      >
        <h3 className="blind-board-config-form__section-title">
          {t('blindBoard.config.memorizeTimeTitle', 'Memorize time')}
        </h3>
        <div
          className="blind-board-config-form__memorize-options"
          role="radiogroup"
          aria-label={t(
            'blindBoard.config.memorizeTimeAria',
            'Memorize time seconds',
          )}
        >
          {BLIND_BOARD_LIMITS.memorizeOptions.map((sec) => {
            const checked = value.memorizeTimeSec === sec;
            return (
              <label
                key={sec}
                className={`blind-board-config-form__memorize-opt${
                  checked
                    ? ' blind-board-config-form__memorize-opt--checked'
                    : ''
                }`}
                data-testid={`blind-board-config-memorize-${sec}`}
                data-checked={checked ? 'true' : 'false'}
              >
                <input
                  type="radio"
                  name="blind-board-memorize"
                  value={sec}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => setMemorize(sec)}
                />
                <span>
                  {t('blindBoard.config.memorizeSeconds', '{{n}} s', {
                    n: sec,
                  })}
                </span>
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );
}
