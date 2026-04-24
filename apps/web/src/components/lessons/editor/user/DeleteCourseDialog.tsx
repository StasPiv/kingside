import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * `DeleteCourseDialog` — деструктивное подтверждение удаления курса
 * (KS-1848 §3.6, KS-1855 / FE-R7).
 *
 * UX: модалка с type-to-confirm — пользователь должен ввести `DELETE`
 * (без учёта регистра/пробелов), чтобы разблокировать кнопку «Удалить».
 * Это защищает от случайного клика в меню `[⋯]` → «Удалить».
 *
 * Controlled: `open` + `onCancel`. При подтверждении — `onConfirm()`,
 * закрытие остаётся на родителе (обычно после успешного DELETE).
 *
 * Есть простая focus-trap на модалку: фокус ставится в input
 * при открытии, Escape вызывает onCancel.
 */

const CONFIRM_PHRASE = 'DELETE';

interface DeleteCourseDialogProps {
  open: boolean;
  courseTitle: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteCourseDialog({
  open,
  courseTitle,
  busy,
  onCancel,
  onConfirm,
}: DeleteCourseDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Сбрасываем value при каждом открытии (чтобы второе открытие не
  // оставалось pre-confirmed после ранее введённого «DELETE» → cancel).
  useEffect(() => {
    if (open) setValue('');
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const normalized = value.trim().toUpperCase();
  const canConfirm = normalized === CONFIRM_PHRASE && !busy;

  return (
    <div
      className="delete-course-dialog__overlay"
      role="presentation"
      data-testid="delete-course-dialog-overlay"
      onClick={onCancel}
    >
      <div
        className="delete-course-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-course-dialog-title"
        data-testid="delete-course-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="delete-course-dialog-title"
          className="delete-course-dialog__title"
        >
          {t('lessons.my.deleteConfirmTitle', 'Delete course?')}
        </h2>
        <p className="delete-course-dialog__body">
          {t('lessons.my.deleteConfirmBody', {
            title: courseTitle,
            defaultValue: 'The course "{{title}}" will be permanently deleted.',
          })}
        </p>
        <label className="delete-course-dialog__field">
          <span>
            {t(
              'lessons.my.deleteConfirmTypeHint',
              'To confirm, type {{phrase}} below.',
              { phrase: CONFIRM_PHRASE },
            )}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            placeholder={CONFIRM_PHRASE}
            data-testid="delete-course-dialog-input"
            autoComplete="off"
          />
        </label>
        <div className="delete-course-dialog__actions">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid="delete-course-dialog-cancel"
          >
            {t('lessons.my.deleteCancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="delete-course-dialog__confirm"
            disabled={!canConfirm}
            onClick={onConfirm}
            data-testid="delete-course-dialog-confirm"
          >
            {busy
              ? t('lessons.my.editor.saving', 'Saving…')
              : t('lessons.my.deleteConfirmAction', 'Delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
