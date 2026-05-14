import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  studiesApi,
  type StudyDto,
  type CreateFromAnalysisRequest,
} from '../../api/studiesApi';

/**
 * KS-2891 / ADR-060 §3.6 (FC6) — модалка «Save to study».
 *
 * Открывается из `AnalysisPage` для context `kind='analysis'` либо
 * `kind='puzzle'` (для review-режима кнопка вообще не рендерится).
 *
 * UX:
 *  • Radio: «Create new study» / «Add to existing».
 *  • При «existing» — список своих студий (`studiesApi.list({mine:1})`).
 *  • При «new» — поле «Study name».
 *  • Поле «Chapter name» (опционально, иначе backend ставит дефолт).
 *  • Submit → `studiesApi.createFromAnalysis(...)`. Успех → success-
 *    panel с CTA «Open chapter» (`navigate('/studies/<slug>/<chapterId>')`).
 *
 * Контекст передаётся через props (`analysisId` или `pgn`+`fen`),
 * чтобы компонент оставался чистым — без зависимости от
 * AnalysisContext.
 */

export type SaveToStudySource =
  | { kind: 'analysis'; analysisId: string }
  | { kind: 'pgn'; pgn: string; fen?: string };

export interface SaveToStudyDialogProps {
  source: SaveToStudySource;
  /** Дефолтное имя главы (например title анализа). */
  defaultChapterName?: string;
  onClose: () => void;
}

type Mode = 'new' | 'existing';

export function SaveToStudyDialog({
  source,
  defaultChapterName,
  onClose,
}: SaveToStudyDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('new');
  const [newStudyName, setNewStudyName] = useState<string>('');
  const [studies, setStudies] = useState<StudyDto[]>([]);
  const [studiesLoading, setStudiesLoading] = useState<boolean>(false);
  const [studiesError, setStudiesError] = useState<string | null>(null);
  const [studyId, setStudyId] = useState<string>('');
  const [chapterName, setChapterName] = useState<string>(
    defaultChapterName ?? '',
  );
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // На успехе показываем success-panel с CTA «Open chapter».
  const [success, setSuccess] = useState<{
    slug: string;
    chapterId: string;
  } | null>(null);

  // Список «своих» студий нужен только когда юзер выбрал
  // existing-режим. Лениво загружаем при первом переключении.
  useEffect(() => {
    if (mode !== 'existing' || studies.length > 0 || studiesLoading) return;
    setStudiesLoading(true);
    setStudiesError(null);
    studiesApi
      .list({ mine: true })
      .then((resp) => {
        setStudies(resp.data);
        if (resp.data.length > 0 && !studyId) {
          setStudyId(resp.data[0].id);
        }
      })
      .catch(() => {
        setStudiesError(
          t(
            'studies.saveToStudy.errorLoadList',
            'Failed to load your studies.',
          ),
        );
      })
      .finally(() => setStudiesLoading(false));
  }, [mode, studies.length, studiesLoading, studyId, t]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;

    const payload: CreateFromAnalysisRequest = {
      ...(source.kind === 'analysis'
        ? { analysisId: source.analysisId }
        : { pgn: source.pgn, fen: source.fen }),
      ...(chapterName.trim() ? { chapterName: chapterName.trim() } : {}),
    };

    if (mode === 'new') {
      const trimmed = newStudyName.trim();
      if (!trimmed) {
        setError(
          t(
            'studies.saveToStudy.errorNewNameRequired',
            'Study name is required.',
          ),
        );
        return;
      }
      payload.newStudyName = trimmed;
    } else {
      if (!studyId) {
        setError(
          t(
            'studies.saveToStudy.errorPickStudy',
            'Pick a study to add the chapter.',
          ),
        );
        return;
      }
      payload.studyId = studyId;
    }

    setSubmitting(true);
    setError(null);
    try {
      const resp = await studiesApi.createFromAnalysis(payload);
      setSuccess({ slug: resp.study.slug, chapterId: resp.chapter.id });
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : t('studies.saveToStudy.errorGeneric', 'Failed to save.'),
      );
    } finally {
      setSubmitting(false);
    }
  }, [submitting, source, chapterName, mode, newStudyName, studyId, t]);

  const handleOpenChapter = useCallback(() => {
    if (!success) return;
    navigate(
      `/studies/${encodeURIComponent(success.slug)}/${encodeURIComponent(
        success.chapterId,
      )}`,
    );
    onClose();
  }, [success, navigate, onClose]);

  return (
    <div
      className="import-pgn-dialog__backdrop"
      role="dialog"
      aria-modal="true"
      data-testid="save-to-study-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="import-pgn-dialog">
        <header className="import-pgn-dialog__header">
          <h2>{t('studies.saveToStudy.title', 'Save to study')}</h2>
          <button
            type="button"
            className="import-pgn-dialog__close"
            data-testid="save-to-study-dialog-close"
            aria-label={t('common.close', 'Close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {success ? (
          <div data-testid="save-to-study-success">
            <p>
              {t(
                'studies.saveToStudy.successMsg',
                'Chapter saved to study.',
              )}
            </p>
            <div className="import-pgn-dialog__actions">
              <button
                type="button"
                className="study-page__action"
                data-testid="save-to-study-open-chapter"
                onClick={handleOpenChapter}
              >
                {t('studies.saveToStudy.openChapter', 'Open chapter')}
              </button>
              <button
                type="button"
                className="study-page__action"
                data-testid="save-to-study-stay"
                onClick={onClose}
              >
                {t('common.close', 'Close')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <fieldset
              className="create-study-dialog__field"
              data-testid="save-to-study-mode"
            >
              <label className="create-study-dialog__checkbox">
                <input
                  type="radio"
                  name="save-to-study-mode"
                  value="new"
                  checked={mode === 'new'}
                  onChange={() => setMode('new')}
                  data-testid="save-to-study-mode-new"
                  disabled={submitting}
                />
                <span>
                  {t(
                    'studies.saveToStudy.modeNew',
                    'Create a new study',
                  )}
                </span>
              </label>
              <label className="create-study-dialog__checkbox">
                <input
                  type="radio"
                  name="save-to-study-mode"
                  value="existing"
                  checked={mode === 'existing'}
                  onChange={() => setMode('existing')}
                  data-testid="save-to-study-mode-existing"
                  disabled={submitting}
                />
                <span>
                  {t(
                    'studies.saveToStudy.modeExisting',
                    'Add to an existing study',
                  )}
                </span>
              </label>
            </fieldset>

            {mode === 'new' ? (
              <label className="create-study-dialog__field">
                <span className="create-study-dialog__label">
                  {t('studies.saveToStudy.newName', 'Study name')} *
                </span>
                <input
                  type="text"
                  className="create-study-dialog__input"
                  data-testid="save-to-study-new-name"
                  value={newStudyName}
                  disabled={submitting}
                  autoFocus
                  maxLength={120}
                  onChange={(e) => setNewStudyName(e.target.value)}
                />
              </label>
            ) : (
              <label className="create-study-dialog__field">
                <span className="create-study-dialog__label">
                  {t('studies.saveToStudy.pickStudy', 'Pick a study')}
                </span>
                {studiesLoading ? (
                  <div data-testid="save-to-study-list-loading">
                    {t('common.loading', 'Loading…')}
                  </div>
                ) : studiesError ? (
                  <div
                    className="import-pgn-dialog__error"
                    data-testid="save-to-study-list-error"
                  >
                    {studiesError}
                  </div>
                ) : studies.length === 0 ? (
                  <div data-testid="save-to-study-list-empty">
                    {t(
                      'studies.saveToStudy.listEmpty',
                      'You don’t have any studies yet — create a new one above.',
                    )}
                  </div>
                ) : (
                  <select
                    className="create-study-dialog__input"
                    data-testid="save-to-study-select"
                    value={studyId}
                    disabled={submitting}
                    onChange={(e) => setStudyId(e.target.value)}
                  >
                    {studies.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}

            <label className="create-study-dialog__field">
              <span className="create-study-dialog__label">
                {t(
                  'studies.saveToStudy.chapterName',
                  'Chapter name (optional)',
                )}
              </span>
              <input
                type="text"
                className="create-study-dialog__input"
                data-testid="save-to-study-chapter-name"
                value={chapterName}
                disabled={submitting}
                maxLength={120}
                onChange={(e) => setChapterName(e.target.value)}
              />
            </label>

            {error && (
              <div
                className="import-pgn-dialog__error"
                data-testid="save-to-study-error"
              >
                {error}
              </div>
            )}

            <div className="import-pgn-dialog__actions">
              <button
                type="button"
                className="study-page__action"
                data-testid="save-to-study-cancel"
                onClick={onClose}
                disabled={submitting}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="study-page__action"
                data-testid="save-to-study-submit"
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting
                  ? t('common.loading', 'Loading…')
                  : t('studies.saveToStudy.submit', 'Save')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * KS-2891: триггер-кнопка «Save to study» для AnalysisHeader rightSlot.
 *
 * Локально держит state `open`, при клике открывает `<SaveToStudyDialog>`.
 * Кнопка не рендерится, если `source` не передан — это сигнал из
 * AnalysisPage что текущий контекст (например, review) не поддерживает
 * сохранение.
 */
export interface SaveToStudyTriggerProps {
  source: SaveToStudySource | null;
  defaultChapterName?: string;
}

export function SaveToStudyTrigger({
  source,
  defaultChapterName,
}: SaveToStudyTriggerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(false);
  if (!source) return null;
  return (
    <>
      <button
        type="button"
        className="study-page__action save-to-study-trigger"
        data-testid="save-to-study-trigger"
        onClick={() => setOpen(true)}
      >
        {t('studies.saveToStudy.trigger', 'Save to study')}
      </button>
      {open && (
        <SaveToStudyDialog
          source={source}
          defaultChapterName={defaultChapterName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
