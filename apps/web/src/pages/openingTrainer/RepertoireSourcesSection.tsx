/**
 * KS-3329 (ADR-078 §5.2). Секция «Источники» на странице репертуара.
 *
 * Показывает список `repertoire.sources` с возможностью CRUD:
 *   - Список карточек: имя (или fallback «Источник #N»), `sourceKind`
 *     значок, дата создания, кнопки Edit / Delete.
 *   - Кнопка «+ Добавить PGN» внизу — модалка для нового источника
 *     (POST /repertoires/:id/sources).
 *   - Edit-модалка — отдельный textarea (PGN) + name (PATCH source).
 *   - Delete с confirm — DELETE source; последний источник удалить
 *     нельзя (backend вернёт 400, фронт превентивно дисэйблит).
 *
 * После любого мутирующего вызова backend возвращает обновлённый
 * `OpeningRepertoireDetailDto`, и вызывающее место (DetailPage)
 * заменяет local state — tree-view перерисуется сразу.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import { OPENING_REPERTOIRE_LIMITS } from '@kingside/shared';
import type {
  OpeningRepertoireDetailDto,
  OpeningRepertoireSourceDto,
  OpeningRepertoireSourceKind,
} from '@kingside/shared';

interface Props {
  repertoireId: string;
  sources: OpeningRepertoireSourceDto[];
  /** Callback вызывается с обновлённым detail-DTO после успешной мутации. */
  onUpdate: (next: OpeningRepertoireDetailDto) => void;
}

const KIND_ICON: Record<OpeningRepertoireSourceKind, string> = {
  'pgn-upload': '📄',
  'workshop-analysis': '🔬',
  'legacy-import': '📦',
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

export function RepertoireSourcesSection({ repertoireId, sources, onUpdate }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);

  const maxSources = OPENING_REPERTOIRE_LIMITS.maxSourcesPerRepertoire;
  const atLimit = sources.length >= maxSources;
  const onlyOne = sources.length <= 1;

  const sorted = useMemo(
    () => [...sources].sort((a, b) => a.order - b.order),
    [sources],
  );

  const handleDelete = useCallback(
    async (source: OpeningRepertoireSourceDto) => {
      if (onlyOne || busy) return;
      const confirmMsg = t(
        'openingTrainer.detail.sources.confirmDelete',
        'Delete this source? Lines from it will be removed from the repertoire tree.',
      );
      if (!window.confirm(confirmMsg)) return;
      setBusy(source.id);
      setError(null);
      try {
        const updated = await openingTrainerApi.deleteRepertoireSource(
          repertoireId,
          source.id,
        );
        onUpdate(updated);
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message
            : t(
                'openingTrainer.detail.sources.errors.deleteFailed',
                'Failed to delete source',
              );
        setError(msg);
      } finally {
        setBusy(null);
      }
    },
    [onlyOne, busy, t, repertoireId, onUpdate],
  );

  const editingSource = sorted.find((s) => s.id === editingSourceId) ?? null;

  return (
    <section
      className="opening-trainer-detail__sources"
      data-testid="opening-trainer-detail-sources"
    >
      <h2 style={{ margin: '0 0 12px' }}>
        {t('openingTrainer.detail.sources.title', 'Sources')}
        <span style={{ fontSize: 13, fontWeight: 400, opacity: 0.7, marginLeft: 8 }}>
          ({sources.length}/{maxSources})
        </span>
      </h2>

      {error && (
        <div className="error" data-testid="opening-trainer-detail-sources-error">
          {error}
        </div>
      )}

      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {sorted.map((source, idx) => (
          <li
            key={source.id}
            data-testid={`opening-trainer-detail-source-${source.id}`}
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              padding: '10px 12px',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.12))',
              borderRadius: 8,
              background: 'var(--bg-surface, transparent)',
              flexWrap: 'wrap',
            }}
          >
            <span
              aria-hidden="true"
              style={{ fontSize: 22 }}
              title={source.sourceKind}
            >
              {KIND_ICON[source.sourceKind]}
            </span>
            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {source.name ||
                  t('openingTrainer.detail.sources.fallbackName', 'Source #{{n}}', {
                    n: idx + 1,
                  })}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                {t(`openingTrainer.detail.sources.kind.${source.sourceKind}`, source.sourceKind)}{' '}
                · {fmtDate(source.createdAt)}
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setEditingSourceId(source.id)}
              disabled={busy !== null}
              data-testid={`opening-trainer-detail-source-edit-${source.id}`}
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              {t('openingTrainer.detail.sources.edit', 'Edit')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void handleDelete(source)}
              disabled={onlyOne || busy === source.id}
              data-testid={`opening-trainer-detail-source-delete-${source.id}`}
              title={
                onlyOne
                  ? t(
                      'openingTrainer.detail.sources.cantDeleteLast',
                      'At least one source is required.',
                    )
                  : undefined
              }
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              {busy === source.id
                ? t('common.loading', 'Loading…')
                : t('openingTrainer.detail.sources.delete', 'Delete')}
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="btn"
        onClick={() => setAddOpen(true)}
        disabled={atLimit || busy !== null}
        data-testid="opening-trainer-detail-source-add"
        title={
          atLimit
            ? t(
                'openingTrainer.detail.sources.atLimit',
                'Source limit reached ({{max}}).',
                { max: maxSources },
              )
            : undefined
        }
        style={{ marginTop: 10 }}
      >
        + {t('openingTrainer.detail.sources.add', 'Add PGN source')}
      </button>

      {addOpen && (
        <SourceFormModal
          mode="add"
          onCancel={() => setAddOpen(false)}
          onSubmit={async (values) => {
            setBusy('add');
            setError(null);
            try {
              const updated = await openingTrainerApi.createRepertoireSource(
                repertoireId,
                {
                  pgn: values.pgn,
                  ...(values.name ? { name: values.name } : {}),
                },
              );
              onUpdate(updated);
              setAddOpen(false);
            } catch (err) {
              const msg =
                err instanceof ApiError
                  ? err.message
                  : t(
                      'openingTrainer.detail.sources.errors.addFailed',
                      'Failed to add source',
                    );
              setError(msg);
            } finally {
              setBusy(null);
            }
          }}
        />
      )}

      {editingSource && (
        <SourceFormModal
          mode="edit"
          initial={{ name: editingSource.name ?? '', pgn: editingSource.pgn }}
          onCancel={() => setEditingSourceId(null)}
          onSubmit={async (values) => {
            setBusy(editingSource.id);
            setError(null);
            try {
              const updated = await openingTrainerApi.updateRepertoireSource(
                repertoireId,
                editingSource.id,
                {
                  pgn: values.pgn,
                  // KS-3329: пустое name → null (сбросить к fallback).
                  name: values.name ? values.name : null,
                },
              );
              onUpdate(updated);
              setEditingSourceId(null);
            } catch (err) {
              const msg =
                err instanceof ApiError
                  ? err.message
                  : t(
                      'openingTrainer.detail.sources.errors.updateFailed',
                      'Failed to update source',
                    );
              setError(msg);
            } finally {
              setBusy(null);
            }
          }}
        />
      )}
    </section>
  );
}

interface SourceFormModalProps {
  mode: 'add' | 'edit';
  initial?: { name: string; pgn: string };
  onCancel: () => void;
  onSubmit: (values: { name: string; pgn: string }) => Promise<void>;
}

function SourceFormModal({ mode, initial, onCancel, onSubmit }: SourceFormModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [pgn, setPgn] = useState(initial?.pgn ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmedPgn = pgn.trim();
    if (!trimmedPgn) {
      setError(t('openingTrainer.new.errors.pgnRequired', 'PGN is required.'));
      return;
    }
    if (new Blob([trimmedPgn]).size > OPENING_REPERTOIRE_LIMITS.maxPgnBytes) {
      setError(
        t(
          'openingTrainer.new.errors.tooLarge',
          'PGN file is too large (max 500KB).',
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim().slice(0, 80), pgn: trimmedPgn });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="opening-trainer-source-modal"
      onClick={() => !busy && onCancel()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9000,
      }}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface, #1f2937)',
          color: 'var(--text-primary, #fff)',
          border: '1px solid var(--border-subtle, rgba(255,255,255,0.12))',
          borderRadius: 10,
          padding: 18,
          maxWidth: 640,
          width: '90%',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <h3 style={{ margin: 0 }}>
          {mode === 'add'
            ? t('openingTrainer.detail.sources.modalAddTitle', 'Add PGN source')
            : t('openingTrainer.detail.sources.modalEditTitle', 'Edit source')}
        </h3>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span>{t('openingTrainer.new.source.name', 'Name (optional)')}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            data-testid="opening-trainer-source-modal-name"
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span>{t('openingTrainer.new.fields.pgn', 'PGN')}</span>
          <textarea
            value={pgn}
            onChange={(e) => setPgn(e.target.value)}
            rows={12}
            data-testid="opening-trainer-source-modal-pgn"
            placeholder={'[Event "?"]\n\n1. e4 c6 2. d4 d5 …'}
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          />
        </label>
        {error && (
          <div className="error" data-testid="opening-trainer-source-modal-error">
            {error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={busy}
            data-testid="opening-trainer-source-modal-cancel"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy}
            data-testid="opening-trainer-source-modal-submit"
          >
            {busy
              ? t('openingTrainer.new.submitting', 'Saving…')
              : t('openingTrainer.detail.sources.modalSave', 'Save')}
          </button>
        </div>
      </form>
    </div>
  );
}
