/**
 * KS-3273 (ADR-077 §2.8 #2). Загрузка нового репертуара.
 *
 * Форма: title (required), description (optional), pgn (textarea required).
 * PGN можно дропнуть файлом — читаем как text/plain. Размер ограничен
 * `OPENING_REPERTOIRE_LIMITS.maxPgnBytes` (500KB), проверяем на клиенте,
 * хотя финальная проверка — на бэке.
 *
 * После успеха navigate(`/opening-trainer/:id`) (карточка с tree).
 */
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import { OPENING_REPERTOIRE_LIMITS } from '@kingside/shared';
import type { TrainerColor } from '@kingside/shared';

export function OpeningTrainerNewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [pgn, setPgn] = useState('');
  // KS-3302: сторона фиксируется при создании репертуара. Default white.
  const [side, setSide] = useState<TrainerColor>('white');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > OPENING_REPERTOIRE_LIMITS.maxPgnBytes) {
        setError(
          t('openingTrainer.new.errors.tooLarge', 'PGN file is too large (max 500KB).'),
        );
        return;
      }
      const text = await file.text();
      setPgn(text);
      if (!title) setTitle(file.name.replace(/\.pgn$/i, ''));
    },
    [t, title],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting) return;
      setError(null);

      const trimmedTitle = title.trim();
      const trimmedPgn = pgn.trim();
      if (!trimmedTitle) {
        setError(t('openingTrainer.new.errors.titleRequired', 'Title is required.'));
        return;
      }
      if (!trimmedPgn) {
        setError(t('openingTrainer.new.errors.pgnRequired', 'PGN is required.'));
        return;
      }
      if (new Blob([trimmedPgn]).size > OPENING_REPERTOIRE_LIMITS.maxPgnBytes) {
        setError(
          t('openingTrainer.new.errors.tooLarge', 'PGN file is too large (max 500KB).'),
        );
        return;
      }

      setSubmitting(true);
      try {
        // KS-3302: side фиксируется при создании.
        const body = {
          title: trimmedTitle,
          pgn: trimmedPgn,
          side,
          ...(description.trim() ? { description: description.trim() } : {}),
        };
        const created = await openingTrainerApi.createRepertoire(body);
        navigate(`/opening-trainer/${created.id}`, { replace: true });
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message
            : t('openingTrainer.new.errors.createFailed', 'Failed to create repertoire.');
        setError(msg);
        setSubmitting(false);
      }
    },
    [submitting, title, pgn, description, t, navigate],
  );

  return (
    <div className="opening-trainer-new" data-testid="opening-trainer-new">
      <header>
        <h1>{t('openingTrainer.new.title', 'New repertoire')}</h1>
        <p>
          {t(
            'openingTrainer.new.subtitle',
            'Upload a PGN with all your opening variations. Transpositions will be collapsed automatically.',
          )}
        </p>
      </header>

      <form onSubmit={handleSubmit} className="opening-trainer-new__form">
        <label className="form-field">
          <span>{t('openingTrainer.new.fields.title', 'Title')}</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t(
              'openingTrainer.new.placeholders.title',
              'e.g. Caro-Kann for Black',
            )}
            maxLength={120}
            required
            data-testid="opening-trainer-new-title"
          />
        </label>

        <label className="form-field">
          <span>{t('openingTrainer.new.fields.description', 'Description (optional)')}</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t(
              'openingTrainer.new.placeholders.description',
              'Short note about this repertoire',
            )}
            maxLength={500}
            data-testid="opening-trainer-new-description"
          />
        </label>

        {/* KS-3302: фиксируем сторону репертуара здесь, один раз. */}
        <div className="form-field" data-testid="opening-trainer-new-side">
          <span className="form-field__label">
            {t('openingTrainer.new.fields.side', 'Train as')}
          </span>
          <div className="radio-group" role="radiogroup">
            <label style={{ marginRight: 16 }}>
              <input
                type="radio"
                name="repertoire-side"
                value="white"
                checked={side === 'white'}
                onChange={() => setSide('white')}
                data-testid="opening-trainer-new-side-white"
              />{' '}
              {t('openingTrainer.new.side.white', 'White')}
            </label>
            <label>
              <input
                type="radio"
                name="repertoire-side"
                value="black"
                checked={side === 'black'}
                onChange={() => setSide('black')}
                data-testid="opening-trainer-new-side-black"
              />{' '}
              {t('openingTrainer.new.side.black', 'Black')}
            </label>
          </div>
        </div>

        <label
          className="opening-trainer-new__drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          data-testid="opening-trainer-new-drop"
        >
          <span className="opening-trainer-new__drop-label">
            {t(
              'openingTrainer.new.drop.label',
              'Drop a .pgn file here or click to browse',
            )}
          </span>
          <input
            type="file"
            accept=".pgn,text/plain"
            onChange={handleFileInput}
            data-testid="opening-trainer-new-file"
          />
        </label>

        <label className="form-field">
          <span>{t('openingTrainer.new.fields.pgn', 'PGN')}</span>
          <textarea
            value={pgn}
            onChange={(e) => setPgn(e.target.value)}
            rows={14}
            placeholder={'[Event "?"]\n[Site "?"]\n[Date "?"]\n\n1. e4 c6 2. d4 d5 …'}
            required
            data-testid="opening-trainer-new-pgn"
          />
        </label>

        {error && (
          <div className="error" data-testid="opening-trainer-new-error">
            {error}
          </div>
        )}

        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => navigate('/opening-trainer')}
            disabled={submitting}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            data-testid="opening-trainer-new-submit"
          >
            {submitting
              ? t('openingTrainer.new.submitting', 'Creating…')
              : t('openingTrainer.new.submit', 'Create')}
          </button>
        </div>
      </form>
    </div>
  );
}
