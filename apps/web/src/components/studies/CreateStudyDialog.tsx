import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { studiesApi, type StudyDto } from '../../api/studiesApi';

/**
 * KS-2852 (KS-2825 acceptance follow-up) — модалка создания студии.
 *
 * Поля: `name` (обязательно), `description` (опц.), `isPublic` (опц.,
 * default off — фича в beta).
 *
 * Submit → `studiesApi.create(req)` → `onCreated(study)`; родитель
 * (`StudiesPage`) делает navigate на `/studies/<slug>`.
 *
 * Закрытие: «×» / «Cancel» / клик по backdrop.
 */

interface CreateStudyDialogProps {
  onClose: () => void;
  onCreated: (study: StudyDto) => void;
}

export function CreateStudyDialog({
  onClose,
  onCreated,
}: CreateStudyDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [isPublic, setIsPublic] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(
        t('studies.create.errorNameRequired', 'Name is required.'),
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const study = await studiesApi.create({
        name: trimmedName,
        description: description.trim() || undefined,
        isPublic,
      });
      onCreated(study);
      onClose();
    } catch (e) {
      const msg =
        e instanceof Error && e.message
          ? e.message
          : t(
              'studies.create.errorGeneric',
              'Failed to create study. Please try again.',
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
      data-testid="create-study-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="import-pgn-dialog">
        <header className="import-pgn-dialog__header">
          <h2>{t('studies.create.title', 'Create study')}</h2>
          <button
            type="button"
            className="import-pgn-dialog__close"
            data-testid="create-study-dialog-close"
            aria-label={t('common.close', 'Close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <label className="create-study-dialog__field">
          <span className="create-study-dialog__label">
            {t('studies.create.name', 'Name')} *
          </span>
          <input
            type="text"
            className="create-study-dialog__input"
            data-testid="create-study-dialog-name"
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

        <label className="create-study-dialog__field">
          <span className="create-study-dialog__label">
            {t('studies.create.description', 'Description (optional)')}
          </span>
          <textarea
            className="create-study-dialog__textarea"
            data-testid="create-study-dialog-description"
            value={description}
            disabled={submitting}
            rows={3}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <label className="create-study-dialog__checkbox">
          <input
            type="checkbox"
            data-testid="create-study-dialog-public"
            checked={isPublic}
            disabled={submitting}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          <span>
            {t(
              'studies.create.isPublic',
              'Make public (anyone with link can view)',
            )}
          </span>
        </label>

        {error && (
          <div
            className="import-pgn-dialog__error"
            data-testid="create-study-dialog-error"
          >
            {error}
          </div>
        )}

        <div className="import-pgn-dialog__actions">
          <button
            type="button"
            className="study-page__action"
            data-testid="create-study-dialog-cancel"
            onClick={onClose}
            disabled={submitting}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="study-page__action"
            data-testid="create-study-dialog-submit"
            onClick={handleSubmit}
            disabled={submitting || !name.trim()}
          >
            {submitting
              ? t('common.loading', 'Loading…')
              : t('studies.create.submit', 'Create')}
          </button>
        </div>
      </div>
    </div>
  );
}
