/**
 * KS-4984 / ADR-167 §7 (задача 3/7). Панель одного челленджа: рисует
 * промпт/доску под текущий режим и контролы ответа (режимы 1–5). Ответ
 * пробрасывается наверх через `onAnswer(value)`; вычисление верности,
 * счёт и переход к следующему — в `VisionSessionRunner`.
 *
 * Разметка минимальна (стили — задача 5/7). Доска рисуется только там,
 * где это часть механики: `find` (клик по клетке) и `name` (подсветка
 * загаданной клетки). Для `color`/`relation`/`geometry` показ клетки
 * раскрыл бы ответ — там текстовый промпт + кнопки.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BlindBoardSquare,
  VisionChallenge,
  VisionRelationKind,
  VisionSquareColor,
} from '@kingside/shared';

import { MemoChessboard } from '../MemoChessboard';

const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';
const HL_TARGET = 'rgba(124, 131, 255, 0.55)';
const HL_CORRECT = 'rgba(107, 190, 92, 0.65)';
const HL_WRONG = 'rgba(214, 84, 84, 0.65)';

/** Ответ пользователя: клетка (find/name), цвет (color) или да/нет. */
export type VisionAnswer = string | boolean;

/** Инфо для показа фидбека после ответа. */
export interface VisionFeedback {
  correct: boolean;
  given: VisionAnswer;
}

export interface VisionChallengePanelProps {
  challenge: VisionChallenge;
  /** Ввод заморожен (во время показа фидбека). */
  disabled: boolean;
  /** Результат последнего ответа для подсветки; `null` в фазе игры. */
  feedback: VisionFeedback | null;
  onAnswer: (value: VisionAnswer) => void;
}

export function VisionChallengePanel(props: VisionChallengePanelProps) {
  const { challenge } = props;
  switch (challenge.mode) {
    case 'color':
      return <ColorPanel {...props} challenge={challenge} />;
    case 'find':
      return <FindPanel {...props} challenge={challenge} />;
    case 'name':
      return <NamePanel {...props} challenge={challenge} />;
    case 'relation':
      return <RelationPanel {...props} challenge={challenge} />;
    case 'geometry':
      return <GeometryPanel {...props} challenge={challenge} />;
  }
}

// ── Режим 1: цвет клетки ─────────────────────────────────────────────
function ColorPanel({
  challenge,
  disabled,
  feedback,
  onAnswer,
}: VisionChallengePanelProps & {
  challenge: Extract<VisionChallenge, { mode: 'color' }>;
}) {
  const { t } = useTranslation();
  const options: VisionSquareColor[] = ['light', 'dark'];
  return (
    <div className="vision-panel vision-panel--color" data-testid="vision-panel">
      <p className="vision-panel__prompt" data-testid="vision-prompt">
        {t('vision.color.prompt', 'What color is the square?')}
      </p>
      <span className="vision-panel__square-label" data-testid="vision-square">
        {challenge.square}
      </span>
      <div className="vision-panel__controls" data-testid="vision-controls">
        {options.map((c) => (
          <button
            key={c}
            type="button"
            className="vision-panel__btn"
            data-testid={`vision-color-${c}`}
            data-answer={c}
            disabled={disabled}
            onClick={() => onAnswer(c)}
          >
            {t(`vision.color.${c}`, c === 'light' ? 'Light' : 'Dark')}
          </button>
        ))}
      </div>
      <FeedbackLine
        feedback={feedback}
        correctLabel={t(
          `vision.color.${challenge.answer}`,
          challenge.answer === 'light' ? 'Light' : 'Dark',
        )}
      />
    </div>
  );
}

// ── Режим 2: найди клетку (клик по доске) ────────────────────────────
function FindPanel({
  challenge,
  disabled,
  feedback,
  onAnswer,
}: VisionChallengePanelProps & {
  challenge: Extract<VisionChallenge, { mode: 'find' }>;
}) {
  const { t } = useTranslation();
  const squareStyles = useMemo(() => {
    if (!feedback) return {};
    const styles: Record<string, React.CSSProperties> = {
      [challenge.answer]: { background: HL_CORRECT },
    };
    if (!feedback.correct && typeof feedback.given === 'string') {
      styles[feedback.given] = { background: HL_WRONG };
    }
    return styles;
  }, [feedback, challenge.answer]);

  const boardOptions = useMemo(
    () => ({
      position: EMPTY_FEN,
      boardOrientation: 'white' as const,
      allowDragging: false,
      showNotation: true,
      squareStyles,
      animationDurationInMs: 0,
      onSquareClick: ({ square }: { square: string }) => {
        if (disabled) return;
        onAnswer(square);
      },
    }),
    [squareStyles, disabled, onAnswer],
  );

  return (
    <div className="vision-panel vision-panel--find" data-testid="vision-panel">
      <p className="vision-panel__prompt" data-testid="vision-prompt">
        {t('vision.find.prompt', 'Click the square')}
      </p>
      <span className="vision-panel__square-label" data-testid="vision-square">
        {challenge.square}
      </span>
      <div
        className="vision-panel__board"
        data-testid="vision-board"
        data-disabled={disabled ? 'true' : 'false'}
      >
        <MemoChessboard options={boardOptions} />
      </div>
      <FeedbackLine feedback={feedback} correctLabel={challenge.answer} />
    </div>
  );
}

// ── Режим 3: назови клетку (подсветка + ввод координаты) ──────────────
function NamePanel({
  challenge,
  disabled,
  feedback,
  onAnswer,
}: VisionChallengePanelProps & {
  challenge: Extract<VisionChallenge, { mode: 'name' }>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');

  // Сброс ввода при смене челленджа.
  useEffect(() => {
    setValue('');
  }, [challenge]);

  const squareStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    if (feedback) {
      return {
        [challenge.square]: {
          background: feedback.correct ? HL_CORRECT : HL_WRONG,
        },
      };
    }
    return { [challenge.square]: { background: HL_TARGET } };
  }, [feedback, challenge.square]);

  const boardOptions = useMemo(
    () => ({
      position: EMPTY_FEN,
      boardOrientation: 'white' as const,
      allowDragging: false,
      showNotation: true,
      squareStyles,
      animationDurationInMs: 0,
    }),
    [squareStyles],
  );

  const normalized = value.trim().toLowerCase();
  const valid = /^[a-h][1-8]$/.test(normalized);

  const submit = () => {
    if (disabled || !valid) return;
    onAnswer(normalized);
  };

  return (
    <div className="vision-panel vision-panel--name" data-testid="vision-panel">
      <p className="vision-panel__prompt" data-testid="vision-prompt">
        {t('vision.name.prompt', 'Name the highlighted square')}
      </p>
      <div
        className="vision-panel__board"
        data-testid="vision-board"
        data-target={challenge.square}
      >
        <MemoChessboard options={boardOptions} />
      </div>
      <form
        className="vision-panel__controls"
        data-testid="vision-controls"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          className="vision-panel__input"
          data-testid="vision-name-input"
          value={value}
          maxLength={2}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          placeholder={t('vision.name.placeholder', 'e.g. e4')}
          aria-label={t('vision.name.prompt', 'Name the highlighted square')}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="submit"
          className="vision-panel__btn"
          data-testid="vision-name-submit"
          disabled={disabled || !valid}
        >
          {t('vision.name.submit', 'Submit')}
        </button>
      </form>
      <FeedbackLine feedback={feedback} correctLabel={challenge.answer} />
    </div>
  );
}

// ── Режим 4: отношение двух клеток (да/нет) ──────────────────────────
function RelationPanel({
  challenge,
  disabled,
  feedback,
  onAnswer,
}: VisionChallengePanelProps & {
  challenge: Extract<VisionChallenge, { mode: 'relation' }>;
}) {
  const { t } = useTranslation();
  const relationLabel = t(
    `vision.relation.${challenge.relation}`,
    RELATION_FALLBACK[challenge.relation],
  );
  return (
    <div
      className="vision-panel vision-panel--relation"
      data-testid="vision-panel"
    >
      <p className="vision-panel__prompt" data-testid="vision-prompt">
        {t(
          'vision.relation.prompt',
          'Are {{a}} and {{b}} on the same {{relation}}?',
          { a: challenge.a, b: challenge.b, relation: relationLabel },
        )}
      </p>
      <YesNoControls disabled={disabled} onAnswer={onAnswer} />
      <FeedbackLine
        feedback={feedback}
        correctLabel={boolLabel(t, challenge.answer)}
      />
    </div>
  );
}

// ── Режим 5: геометрия фигуры (да/нет) ───────────────────────────────
function GeometryPanel({
  challenge,
  disabled,
  feedback,
  onAnswer,
}: VisionChallengePanelProps & {
  challenge: Extract<VisionChallenge, { mode: 'geometry' }>;
}) {
  const { t } = useTranslation();
  const pieceLabel = t(
    `vision.piece.${challenge.piece}`,
    PIECE_FALLBACK[challenge.piece],
  );
  return (
    <div
      className="vision-panel vision-panel--geometry"
      data-testid="vision-panel"
    >
      <p className="vision-panel__prompt" data-testid="vision-prompt">
        {t(
          'vision.geometry.prompt',
          'Does the {{piece}} on {{from}} attack {{target}}?',
          {
            piece: pieceLabel,
            from: challenge.from,
            target: challenge.target,
          },
        )}
      </p>
      <YesNoControls disabled={disabled} onAnswer={onAnswer} />
      <FeedbackLine
        feedback={feedback}
        correctLabel={boolLabel(t, challenge.answer)}
      />
    </div>
  );
}

// ── Общие мелкие компоненты ──────────────────────────────────────────
function YesNoControls({
  disabled,
  onAnswer,
}: {
  disabled: boolean;
  onAnswer: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="vision-panel__controls" data-testid="vision-controls">
      <button
        type="button"
        className="vision-panel__btn vision-panel__btn--yes"
        data-testid="vision-answer-yes"
        disabled={disabled}
        onClick={() => onAnswer(true)}
      >
        {t('vision.answer.yes', 'Yes')}
      </button>
      <button
        type="button"
        className="vision-panel__btn vision-panel__btn--no"
        data-testid="vision-answer-no"
        disabled={disabled}
        onClick={() => onAnswer(false)}
      >
        {t('vision.answer.no', 'No')}
      </button>
    </div>
  );
}

function FeedbackLine({
  feedback,
  correctLabel,
}: {
  feedback: VisionFeedback | null;
  correctLabel: string;
}) {
  const { t } = useTranslation();
  if (!feedback) return null;
  return (
    <p
      className="vision-panel__feedback"
      data-testid="vision-feedback"
      data-correct={feedback.correct ? 'true' : 'false'}
      role="status"
    >
      {feedback.correct
        ? t('vision.feedback.correct', 'Correct')
        : t('vision.feedback.wrong', 'Wrong — {{answer}}', {
            answer: correctLabel,
          })}
    </p>
  );
}

function boolLabel(
  t: ReturnType<typeof useTranslation>['t'],
  v: boolean,
): string {
  return v ? t('vision.answer.yes', 'Yes') : t('vision.answer.no', 'No');
}

const RELATION_FALLBACK: Record<VisionRelationKind, string> = {
  diagonal: 'diagonal',
  file: 'file',
  rank: 'rank',
  color: 'color',
};

const PIECE_FALLBACK: Record<string, string> = {
  N: 'knight',
  B: 'bishop',
  R: 'rook',
  Q: 'queen',
};

// Ре-экспорт для тестов/типизации потребителей.
export type { BlindBoardSquare };
