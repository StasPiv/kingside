import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DrillExplanation,
  DrillExplanationNote,
  DrillExplanationNoteTone,
} from './explanation/types';

/**
 * KS-2457 (ADR-043 §4). Панель разбора drill'а: заголовок (Correct! /
 * Not quite), список текстовых notes от `explainDrill()` и кнопка
 * «Дальше». Появляется при `state='feedback'` рядом с доской (desktop)
 * или под ней (mobile, см. CSS-брейкпоинт 768px в drills.css).
 *
 * Pure-prepresentational: всю логику (вычисление explanation, прерывание
 * auto-next, переход к следующему drill'у) держит host (DrillRunner).
 *
 * # Контракт DOM
 *
 *   <div class="drill-explanation-panel"
 *        data-testid="drill-explanation-panel"
 *        data-result="correct|incorrect">
 *     <h3 class="drill-explanation-panel__title"
 *         data-testid="drill-explanation-panel-title">…</h3>
 *     <ul class="drill-explanation-panel__notes">
 *       <li class="drill-explanation-panel__note drill-explanation-panel__note--<tone>"
 *           data-testid="drill-explanation-note"
 *           data-tone="success|missed|wrong|info">…</li>
 *       …
 *     </ul>
 *     <button class="drill-explanation-panel__next"
 *             data-testid="drill-explanation-next">Next</button>
 *   </div>
 *
 * # i18n
 *
 * KS-2457 принимает `explanation.notes[*].key` напрямую — i18n-strings
 * наполняются в KS-2459 (RU/EN). Если ключ ещё не переведён, i18next
 * вернёт сам ключ — это видно при ручной верификации на DevDrill-
 * ExplanationPage.
 *
 * Иконку tone'а в MVP рендерим как unicode-символ:
 *  - success — ✓
 *  - missed  — ⊘
 *  - wrong   — ✕
 *  - info    — •
 *
 * Финальные иконки + цвета — KS-2458 layout.
 */
export interface DrillExplanationPanelProps {
  explanation: DrillExplanation;
  /** true — пользователь решил drill верно. */
  solved: boolean;
  /** Лейбл primary-кнопки. По умолчанию `t('drills.buttons.next')`. */
  nextLabel?: string;
  /**
   * Колбэк по клику «Дальше». Host (DrillRunner) реализует прерывание
   * auto-next-таймера и переход к следующему drill'у.
   */
  onNext: () => void;
}

const TONE_GLYPH: Record<DrillExplanationNoteTone, string> = {
  success: '✓',
  missed: '⊘',
  wrong: '✕',
  info: '•',
};

function NoteItem({ note }: { note: DrillExplanationNote }) {
  const { t } = useTranslation();
  // KS-2459: пока ключи не переведены, fallback — сам ключ +
  // подставленные params (i18next подставит {param} даже без перевода).
  const text = t(note.key, { defaultValue: note.key, ...note.params });
  return (
    <li
      className={`drill-explanation-panel__note drill-explanation-panel__note--${note.tone}`}
      data-testid="drill-explanation-note"
      data-tone={note.tone}
    >
      <span
        className="drill-explanation-panel__note-glyph"
        aria-hidden="true"
      >
        {TONE_GLYPH[note.tone]}
      </span>
      <span className="drill-explanation-panel__note-text">{text}</span>
    </li>
  );
}

function DrillExplanationPanelImpl({
  explanation,
  solved,
  nextLabel,
  onNext,
}: DrillExplanationPanelProps) {
  const { t } = useTranslation();
  const result = solved ? 'correct' : 'incorrect';
  const titleKey = solved ? 'drills.feedback.correct' : 'drills.feedback.incorrect';
  const titleFallback = solved ? 'Correct!' : 'Not quite';
  return (
    <div
      className={`drill-explanation-panel drill-explanation-panel--${result}`}
      data-testid="drill-explanation-panel"
      data-result={result}
    >
      <h3
        className="drill-explanation-panel__title"
        data-testid="drill-explanation-panel-title"
      >
        {t(titleKey, titleFallback)}
      </h3>
      {explanation.notes.length > 0 && (
        <ul className="drill-explanation-panel__notes">
          {explanation.notes.map((n, idx) => (
            <NoteItem key={`${n.key}-${idx}`} note={n} />
          ))}
        </ul>
      )}
      <button
        type="button"
        className="drill-explanation-panel__next"
        data-testid="drill-explanation-next"
        onClick={onNext}
      >
        {nextLabel ?? t('drills.buttons.next', 'Next')}
      </button>
    </div>
  );
}

export const DrillExplanationPanel = memo(DrillExplanationPanelImpl);
