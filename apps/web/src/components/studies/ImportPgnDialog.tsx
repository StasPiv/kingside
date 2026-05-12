import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { studiesApi } from '../../api/studiesApi';

/**
 * KS-2830 (KS-2815 §B.5) — модалка импорта multi-PGN в студию.
 *
 * UX:
 *   1. Textarea для PGN или file-upload (.pgn).
 *   2. Превью: «Found N games».
 *   3. Submit → `studiesApi.importPgn(slug, pgn)` → onCreated с
 *      массивом созданных глав; родитель обновляет список.
 *
 * Локальный `countGames` — лёгкий regex: каждый game в PGN начинается
 * с tag-pair `[Event "..."]` (case-insensitive, в начале строки).
 * Backend `splitPgn` точнее, но для превью этого достаточно (если
 * счётчик не совпадёт на 1-2 — не критично, конечное число придёт
 * с ответом).
 */

interface ImportPgnDialogProps {
  slug: string;
  onClose: () => void;
  onImported: (createdCount: number) => void;
}

/** Лёгкий счётчик количества игр в PGN — `[Event ...]` в начале строки. */
export function countGamesInPgn(pgn: string): number {
  // Trim — пустой / только whitespace = 0.
  if (!pgn.trim()) return 0;
  const matches = pgn.match(/^\s*\[Event\s/gim);
  // Если ни одной [Event] нет, но текст не пустой — backend всё равно
  // попытается импортировать как одну игру.
  return matches && matches.length > 0 ? matches.length : 1;
}

export function ImportPgnDialog({
  slug,
  onClose,
  onImported,
}: ImportPgnDialogProps) {
  const { t } = useTranslation();
  const [pgn, setPgn] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const previewCount = useMemo(() => countGamesInPgn(pgn), [pgn]);

  const handleFile = async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      setPgn(text);
    } catch {
      setError(
        t(
          'studies.import.errorReadFile',
          'Could not read file. Please try copy-pasting the PGN text directly.',
        ),
      );
    }
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmed = pgn.trim();
    if (!trimmed) {
      setError(t('studies.import.errorEmpty', 'PGN cannot be empty.'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const resp = await studiesApi.importPgn(slug, trimmed);
      onImported(resp.created.length);
      onClose();
    } catch (e) {
      // Backend может вернуть 413 «too many games» или 400 «invalid PGN».
      // Без specific-парсинга — показываем общий текст.
      const msg =
        e instanceof Error && e.message
          ? e.message
          : t(
              'studies.import.errorGeneric',
              'PGN import failed. Check the syntax and the chapter limit.',
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
      data-testid="import-pgn-dialog"
      onClick={(e) => {
        // Закрытие по клику на бэкдропе (не на содержимое).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="import-pgn-dialog">
        <header className="import-pgn-dialog__header">
          <h2>{t('studies.import.title', 'Import PGN')}</h2>
          <button
            type="button"
            className="import-pgn-dialog__close"
            data-testid="import-pgn-dialog-close"
            aria-label={t('common.close', 'Close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <p className="import-pgn-dialog__hint">
          {t(
            'studies.import.hint',
            'Paste PGN below or upload a .pgn file. Each game becomes a separate chapter.',
          )}
        </p>

        <div className="import-pgn-dialog__file-row">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pgn,text/x-chess-pgn,text/plain"
            data-testid="import-pgn-dialog-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
        </div>

        <textarea
          className="import-pgn-dialog__textarea"
          data-testid="import-pgn-dialog-textarea"
          value={pgn}
          onChange={(e) => setPgn(e.target.value)}
          rows={12}
          placeholder={t(
            'studies.import.placeholder',
            'Paste PGN here. Multiple games separated by [Event ...] headers are supported.',
          )}
        />

        <div className="import-pgn-dialog__meta">
          <span data-testid="import-pgn-dialog-count">
            {t('studies.import.foundGames', {
              count: previewCount,
              defaultValue: '{{count}} game found',
              defaultValue_other: '{{count}} games found',
            })}
          </span>
        </div>

        {error && (
          <div className="import-pgn-dialog__error" data-testid="import-pgn-dialog-error">
            {error}
          </div>
        )}

        <div className="import-pgn-dialog__actions">
          <button
            type="button"
            className="study-page__action"
            data-testid="import-pgn-dialog-cancel"
            onClick={onClose}
            disabled={submitting}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="study-page__action"
            data-testid="import-pgn-dialog-submit"
            onClick={handleSubmit}
            disabled={submitting || !pgn.trim()}
          >
            {submitting
              ? t('common.loading', 'Loading…')
              : t('studies.import.submit', 'Import')}
          </button>
        </div>
      </div>
    </div>
  );
}
