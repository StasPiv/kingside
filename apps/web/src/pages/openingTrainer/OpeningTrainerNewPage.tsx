/**
 * KS-3273 + KS-3302 + KS-3328 (multi-source). Загрузка нового репертуара.
 *
 * KS-3328 (ADR-078 §5.1): динамический список PGN-блоков-источников.
 * Каждый источник — `{ name?, pgn }`. Минимум 1, максимум
 * `OPENING_REPERTOIRE_LIMITS.maxSourcesPerRepertoire` (= 20).
 * Backend в KS-3324/3326 принимает `{ sources: [{pgn, name?}, ...] }`
 * через POST /opening-trainer/repertoires (legacy `pgn` поле тоже
 * поддерживается, но мы шлём новый формат).
 *
 * Side фиксируется при создании (KS-3302).
 */
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import { OPENING_REPERTOIRE_LIMITS } from '@kingside/shared';
import type { TrainerColor } from '@kingside/shared';

interface SourceBlock {
  /** Локальный uid — для key React и подсветки ошибок. */
  uid: string;
  name: string;
  pgn: string;
  /** Локальная ошибка (превышение байт / пустой PGN). */
  error?: string;
}

let nextUid = 0;
function makeBlock(): SourceBlock {
  nextUid += 1;
  return { uid: `src-${nextUid}`, name: '', pgn: '' };
}

export function OpeningTrainerNewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [side, setSide] = useState<TrainerColor>('white');
  const [sources, setSources] = useState<SourceBlock[]>(() => [makeBlock()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxSources = OPENING_REPERTOIRE_LIMITS.maxSourcesPerRepertoire;

  const handleFileForBlock = useCallback(
    async (blockUid: string, file: File) => {
      if (file.size > OPENING_REPERTOIRE_LIMITS.maxPgnBytes) {
        setSources((prev) =>
          prev.map((b) =>
            b.uid === blockUid
              ? {
                  ...b,
                  error: t(
                    'openingTrainer.new.errors.tooLarge',
                    'PGN file is too large (max 500KB).',
                  ),
                }
              : b,
          ),
        );
        return;
      }
      const text = await file.text();
      setSources((prev) =>
        prev.map((b) =>
          b.uid === blockUid
            ? {
                ...b,
                pgn: text,
                name: b.name || file.name.replace(/\.pgn$/i, ''),
                error: undefined,
              }
            : b,
        ),
      );
      if (!title) {
        setTitle(file.name.replace(/\.pgn$/i, ''));
      }
    },
    [t, title],
  );

  const addBlock = useCallback(() => {
    if (sources.length >= maxSources) return;
    setSources((prev) => [...prev, makeBlock()]);
  }, [sources.length, maxSources]);

  const removeBlock = useCallback(
    (uid: string) => {
      setSources((prev) => (prev.length <= 1 ? prev : prev.filter((b) => b.uid !== uid)));
    },
    [],
  );

  const updateBlock = useCallback(
    (uid: string, patch: Partial<Pick<SourceBlock, 'name' | 'pgn'>>) => {
      setSources((prev) =>
        prev.map((b) => (b.uid === uid ? { ...b, ...patch, error: undefined } : b)),
      );
    },
    [],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting) return;
      setError(null);

      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        setError(t('openingTrainer.new.errors.titleRequired', 'Title is required.'));
        return;
      }

      // Подготовим source-list. Игнорируем полностью пустые блоки (юзер
      // нажал «+» но не заполнил), но требуем минимум 1 непустой.
      const cleaned: { name?: string; pgn: string }[] = [];
      let perBlockError: { uid: string; msg: string } | null = null;
      for (const b of sources) {
        const trimmedPgn = b.pgn.trim();
        if (!trimmedPgn) continue;
        if (new Blob([trimmedPgn]).size > OPENING_REPERTOIRE_LIMITS.maxPgnBytes) {
          perBlockError = {
            uid: b.uid,
            msg: t(
              'openingTrainer.new.errors.tooLarge',
              'PGN file is too large (max 500KB).',
            ),
          };
          break;
        }
        const trimmedName = b.name.trim();
        cleaned.push({
          pgn: trimmedPgn,
          ...(trimmedName ? { name: trimmedName.slice(0, 80) } : {}),
        });
      }

      if (perBlockError) {
        setSources((prev) =>
          prev.map((b) =>
            b.uid === perBlockError!.uid ? { ...b, error: perBlockError!.msg } : b,
          ),
        );
        return;
      }
      if (cleaned.length === 0) {
        setError(t('openingTrainer.new.errors.pgnRequired', 'PGN is required.'));
        return;
      }
      if (cleaned.length > maxSources) {
        setError(
          t(
            'openingTrainer.new.errors.tooManySources',
            'Too many sources (max {{max}}).',
            { max: maxSources },
          ),
        );
        return;
      }

      setSubmitting(true);
      try {
        const created = await openingTrainerApi.createRepertoire({
          title: trimmedTitle,
          sources: cleaned,
          side,
          ...(description.trim() ? { description: description.trim() } : {}),
        });
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
    [submitting, title, description, sources, side, navigate, t, maxSources],
  );

  return (
    <div className="opening-trainer-new" data-testid="opening-trainer-new">
      <header>
        <h1>{t('openingTrainer.new.title', 'New repertoire')}</h1>
        <p>
          {t(
            'openingTrainer.new.subtitle',
            'Upload one or more PGN blocks. They will be merged into a single training tree (transpositions are auto-collapsed).',
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

        <div className="form-field" data-testid="opening-trainer-new-side">
          <span className="form-field__label" style={{ display: 'block', marginBottom: 6 }}>
            {t('openingTrainer.new.fields.side', 'Train as')}
          </span>
          <div
            className="radio-group"
            role="radiogroup"
            style={{ display: 'flex', gap: 24, alignItems: 'center' }}
          >
            <label
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
            >
              <input
                type="radio"
                name="repertoire-side"
                value="white"
                checked={side === 'white'}
                onChange={() => setSide('white')}
                data-testid="opening-trainer-new-side-white"
                style={{ appearance: 'auto', width: 'auto', border: 'none', background: 'transparent', padding: 0, margin: 0, minWidth: 0 }}
              />
              {t('openingTrainer.new.side.white', 'White')}
            </label>
            <label
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
            >
              <input
                type="radio"
                name="repertoire-side"
                value="black"
                checked={side === 'black'}
                onChange={() => setSide('black')}
                data-testid="opening-trainer-new-side-black"
                style={{ appearance: 'auto', width: 'auto', border: 'none', background: 'transparent', padding: 0, margin: 0, minWidth: 0 }}
              />
              {t('openingTrainer.new.side.black', 'Black')}
            </label>
          </div>
        </div>

        {/* KS-3328: динамический список PGN-блоков-источников. */}
        <div
          className="opening-trainer-new__sources"
          data-testid="opening-trainer-new-sources"
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          {sources.map((block, idx) => (
            <SourceBlockEditor
              key={block.uid}
              block={block}
              index={idx}
              total={sources.length}
              onChange={(patch) => updateBlock(block.uid, patch)}
              onRemove={() => removeBlock(block.uid)}
              onFile={(file) => void handleFileForBlock(block.uid, file)}
            />
          ))}

          <button
            type="button"
            className="btn"
            onClick={addBlock}
            disabled={sources.length >= maxSources}
            data-testid="opening-trainer-new-add-source"
            title={
              sources.length >= maxSources
                ? t(
                    'openingTrainer.new.errors.tooManySources',
                    'Too many sources (max {{max}}).',
                    { max: maxSources },
                  )
                : undefined
            }
            style={{ alignSelf: 'flex-start' }}
          >
            +{' '}
            {t('openingTrainer.new.addSource', 'Add another PGN')}
            {sources.length > 0 && (
              <span style={{ opacity: 0.7, marginLeft: 6, fontSize: 12 }}>
                ({sources.length}/{maxSources})
              </span>
            )}
          </button>
        </div>

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

interface SourceBlockEditorProps {
  block: SourceBlock;
  index: number;
  total: number;
  onChange: (patch: Partial<Pick<SourceBlock, 'name' | 'pgn'>>) => void;
  onRemove: () => void;
  onFile: (file: File) => void;
}

function SourceBlockEditor({
  block,
  index,
  total,
  onChange,
  onRemove,
  onFile,
}: SourceBlockEditorProps) {
  const { t } = useTranslation();
  const headingId = `opening-trainer-new-source-${block.uid}`;
  return (
    <fieldset
      data-testid={`opening-trainer-new-source-block-${index}`}
      data-error={block.error ? 'true' : 'false'}
      style={{
        border: block.error
          ? '1.5px solid var(--danger, #ef4444)'
          : '1px solid var(--border-subtle, rgba(255,255,255,0.12))',
        borderRadius: 8,
        padding: '12px 14px',
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <legend
        id={headingId}
        style={{
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          fontWeight: 600,
          padding: '0 6px',
          color: 'var(--text-secondary)',
        }}
      >
        {t('openingTrainer.new.source.heading', 'Source')} #{index + 1}
        {total > 1 && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={onRemove}
            data-testid={`opening-trainer-new-remove-source-${index}`}
            title={t('openingTrainer.new.removeSource', 'Remove this PGN block')}
            style={{
              marginLeft: 10,
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 6,
            }}
          >
            −
          </button>
        )}
      </legend>

      <label className="form-field">
        <span>
          {t('openingTrainer.new.source.name', 'Name (optional)')}
        </span>
        <input
          type="text"
          value={block.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t(
            'openingTrainer.new.source.namePlaceholder',
            'e.g. Sicilian Najdorf 6.Be3',
          )}
          maxLength={80}
          data-testid={`opening-trainer-new-source-name-${index}`}
        />
      </label>

      <label
        className="opening-trainer-new__drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
        data-testid={`opening-trainer-new-source-drop-${index}`}
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
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
          }}
          data-testid={`opening-trainer-new-source-file-${index}`}
        />
      </label>

      <label className="form-field">
        <span>{t('openingTrainer.new.fields.pgn', 'PGN')}</span>
        <textarea
          value={block.pgn}
          onChange={(e) => onChange({ pgn: e.target.value })}
          rows={10}
          placeholder={'[Event "?"]\n\n1. e4 c6 2. d4 d5 …'}
          data-testid={`opening-trainer-new-source-pgn-${index}`}
        />
      </label>

      {block.error && (
        <div
          className="error"
          data-testid={`opening-trainer-new-source-error-${index}`}
        >
          {block.error}
        </div>
      )}
    </fieldset>
  );
}
