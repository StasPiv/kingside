import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  studiesApi,
  type StudyChapterDto,
} from '../../api/studiesApi';

/**
 * KS-3125 — модалка создания главы.
 *
 * Поля: `name` (обязательно).
 *
 * До KS-3014 (коммит 4092dd97) `+ New chapter` создавал главу и сразу
 * уводил в editor-роут `/studies/:slug/:chapterId`. После удаления
 * editor-роута переход стал ловиться wildcard-fallback и уносил
 * пользователя на `/play`. Этот диалог — минимальный UI создания: имя →
 * `createChapter` → callback в родителя для reload. Без переходов.
 *
 * Закрытие: «×» / «Cancel» / клик по backdrop.
 */

interface CreateChapterDialogProps {
  slug: string;
  onClose: () => void;
  onCreated: (chapter: StudyChapterDto) => void;
}

export function CreateChapterDialog({
  slug,
  onClose,
  onCreated,
}: CreateChapterDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState<string>(
    t('studies.chapter.defaultName', 'New chapter'),
  );
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(
        t('studies.createChapter.errorNameRequired', 'Name is required.'),
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const chapter = await studiesApi.createChapter(slug, {
        name: trimmedName,
      });
      onCreated(chapter);
      onClose();
    } catch (e) {
      const msg =
        e instanceof Error && e.message
          ? e.message
          : t(
              'studies.createChapter.errorGeneric',
              'Failed to create chapter. Please try again.',
            );
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="import-pgn-dialog__backdrop"
      role="dialog"
      aria-modal="true"
      data-testid="create-chapter-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="import-pgn-dialog">
        <header className="import-pgn-dialog__header">
          <h2>
            {t('studies.createChapter.title', 'Create chapter')}
          </h2>
          <button
            type="button"
            className="import-pgn-dialog__close"
            data-testid="create-chapter-dialog-close"
            aria-label={t('common.close', 'Close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <label className="create-study-dialog__field">
          <span className="create-study-dialog__label">
            {t('studies.createChapter.name', 'Name')} *
          </span>
          <input
            type="text"
            className="create-study-dialog__input"
            data-testid="create-chapter-dialog-name"
            value={name}
            disabled={submitting}
            autoFocus
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          />
        </label>

        {error && (
          <div
            className="import-pgn-dialog__error"
            data-testid="create-chapter-dialog-error"
          >
            {error}
          </div>
        )}

        <div className="import-pgn-dialog__actions">
          <button
            type="button"
            className="study-page__action"
            data-testid="create-chapter-dialog-cancel"
            onClick={onClose}
            disabled={submitting}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="study-page__action"
            data-testid="create-chapter-dialog-submit"
            onClick={handleSubmit}
            disabled={submitting || !name.trim()}
          >
            {submitting
              ? t('common.loading', 'Loading…')
              : t('studies.createChapter.submit', 'Create')}
          </button>
        </div>
      </div>
    </div>
  );
}
