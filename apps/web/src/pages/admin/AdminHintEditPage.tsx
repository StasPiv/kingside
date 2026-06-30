/**
 * KS-4706 / ADR-147 §3.3. Форма создания/редактирования подсказки.
 *
 * Маршруты:
 *   `/admin/hints/new`      — `POST /admin/hints`
 *   `/admin/hints/:id`      — `GET` детальная + `PUT` сохранение
 *
 * UI:
 *   - вкладки i18n (ru/en) — title/body/ctaLabel;
 *   - поля: key, anchor (свободная строка [a-z][a-z0-9-]*),
 *     placement (select),
 *     priority, cooldownSec, ttlSec, maxShows, targetActorTypes
 *     (multi-select user/guest), acceptedBy (tag-input);
 *   - DSL editor (JSON textarea, валидация на blur);
 *   - кнопка «Предпросмотр охвата» → `POST /admin/hints/preview-trigger`
 *     с показом `{estimate, sampled, capped}`;
 *   - 400 backend (валидация DSL) → показ сообщения у DSL-поля;
 *   - 409 backend (дубль key) → показ сообщения у key-поля.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../ApiError';
import {
  hintsAdminApi,
  type AdminHintDetail,
  type CreateHintInput,
  type HintActorType,
  type HintI18n,
  type HintI18nEntry,
  type HintPlacement,
  type PreviewTriggerResponse,
} from '../../api/api-hints-admin';

const PLACEMENTS: HintPlacement[] = [
  'top',
  'bottom',
  'left',
  'right',
  'overlay',
  'bottom-sheet',
];

const DEFAULT_RULE = `{
  "all": []
}`;

interface FormState {
  key: string;
  anchor: string;
  placement: HintPlacement;
  priority: number;
  enabled: boolean;
  cooldownSec: number;
  ttlSec: number;
  maxShows: number;
  targetActorTypes: HintActorType[];
  acceptedBy: string[];
  i18n: HintI18n;
  ctaHref: string;
  ctaEvent: string;
  ruleText: string;
}

function emptyEntry(): HintI18nEntry {
  return { title: '', body: '', ctaLabel: undefined, instructionBody: undefined };
}

function defaultForm(): FormState {
  return {
    key: '',
    anchor: '',
    placement: 'bottom',
    priority: 0,
    enabled: false,
    cooldownSec: 86_400,
    ttlSec: 0,
    maxShows: 3,
    targetActorTypes: ['user'],
    acceptedBy: [],
    i18n: { ru: emptyEntry(), en: emptyEntry() },
    ctaHref: '',
    ctaEvent: '',
    ruleText: DEFAULT_RULE,
  };
}

function detailToForm(d: AdminHintDetail): FormState {
  return {
    key: d.key,
    anchor: d.anchor,
    placement: d.placement,
    priority: d.priority,
    enabled: d.enabled,
    cooldownSec: d.cooldownSec,
    ttlSec: d.ttlSec,
    maxShows: d.maxShows,
    targetActorTypes: d.targetActorTypes as HintActorType[],
    acceptedBy: d.acceptedBy ?? [],
    i18n: {
      ru: d.i18n?.ru ?? emptyEntry(),
      en: d.i18n?.en ?? emptyEntry(),
    },
    ctaHref: d.cta?.href ?? '',
    ctaEvent: d.cta?.event ?? '',
    ruleText: JSON.stringify(d.rule ?? {}, null, 2),
  };
}

export function AdminHintEditPage(): ReactElement {
  const { t } = useTranslation();
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [form, setForm] = useState<FormState>(defaultForm);
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [activeLocale, setActiveLocale] = useState<'ru' | 'en'>('ru');
  const [preview, setPreview] = useState<PreviewTriggerResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !id) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    hintsAdminApi
      .getOne(id)
      .then((d) => {
        if (!cancelled) setForm(detailToForm(d));
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : 'load failed');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, isEdit]);

  const parsedRule = useMemo<Record<string, unknown> | null>(() => {
    try {
      const v = JSON.parse(form.ruleText);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }, [form.ruleText]);

  const validateRuleSyntax = useCallback(() => {
    if (parsedRule === null) {
      setRuleError(
        t(
          'adminHints.form.ruleParseError',
          'Rule must be a JSON object with operators (all/any/not/page/count/exists/timeSince/actorType).',
        ),
      );
      return false;
    }
    setRuleError(null);
    return true;
  }, [parsedRule, t]);

  const onPreview = useCallback(async () => {
    if (!validateRuleSyntax() || !parsedRule) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await hintsAdminApi.previewTrigger(parsedRule);
      setPreview(res);
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status} ${e.message}` : (e instanceof Error ? e.message : 'preview failed');
      setPreviewError(msg);
    } finally {
      setPreviewLoading(false);
    }
  }, [parsedRule, validateRuleSyntax]);

  const buildInput = useCallback((): CreateHintInput | null => {
    if (!parsedRule) {
      setRuleError(t('adminHints.form.ruleParseError', 'Rule must be a JSON object.'));
      return null;
    }
    const ru = form.i18n.ru;
    const en = form.i18n.en;
    const i18n: HintI18n = {};
    if (ru?.title?.trim()) i18n.ru = stripEmpty(ru);
    if (en?.title?.trim()) i18n.en = stripEmpty(en);
    const cta =
      form.ctaHref.trim() || form.ctaEvent.trim()
        ? {
            ...(form.ctaHref.trim() ? { href: form.ctaHref.trim() } : {}),
            ...(form.ctaEvent.trim() ? { event: form.ctaEvent.trim() } : {}),
          }
        : undefined;
    return {
      key: form.key.trim(),
      anchor: form.anchor,
      placement: form.placement,
      priority: form.priority,
      enabled: form.enabled,
      cooldownSec: form.cooldownSec,
      ttlSec: form.ttlSec,
      maxShows: form.maxShows,
      targetActorTypes: form.targetActorTypes,
      acceptedBy: form.acceptedBy,
      i18n,
      ...(cta ? { cta } : {}),
      rule: parsedRule,
    };
  }, [form, parsedRule, t]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setKeyError(null);
      setSaveError(null);
      const input = buildInput();
      if (!input) return;
      setSaving(true);
      try {
        const saved = isEdit && id
          ? await hintsAdminApi.update(id, input)
          : await hintsAdminApi.create(input);
        navigate(`/admin/hints/${saved.id}`, { replace: true });
      } catch (e2) {
        if (e2 instanceof ApiError && e2.status === 409) {
          setKeyError(t('adminHints.form.keyDuplicate', 'A hint with this key already exists.'));
        } else if (e2 instanceof ApiError && e2.status === 400) {
          const msg = e2.message || 'invalid';
          setRuleError(msg);
          setSaveError(msg);
        } else {
          setSaveError(e2 instanceof Error ? e2.message : 'save failed');
        }
      } finally {
        setSaving(false);
      }
    },
    [buildInput, id, isEdit, navigate, t],
  );

  if (loading) {
    return (
      <div className="admin-page" data-testid="admin-hint-edit-loading">
        {t('common.loading', 'Loading…')}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="admin-page" data-testid="admin-hint-edit-load-error">
        {loadError}
      </div>
    );
  }

  return (
    <div className="admin-page" data-testid="admin-hint-edit-page">
      <header className="admin-page__header">
        <h1>
          {isEdit
            ? t('adminHints.editTitle', 'Edit hint')
            : t('adminHints.createTitle', 'New hint')}
        </h1>
      </header>

      <form onSubmit={(e) => void onSubmit(e)}>
        {/* ── Common fields ────────────────────────────────── */}
        <fieldset>
          <legend>{t('adminHints.form.common', 'Common')}</legend>
          <label>
            {t('adminHints.form.key', 'Key')}
            <input
              type="text"
              required
              pattern="[a-z][a-z0-9-]*"
              maxLength={64}
              value={form.key}
              disabled={isEdit}
              onChange={(e) => setForm((s) => ({ ...s, key: e.currentTarget.value }))}
              data-testid="admin-hint-form-key"
            />
            {keyError && (
              <span className="admin-page__error" data-testid="admin-hint-form-key-error">
                {keyError}
              </span>
            )}
          </label>
          <label>
            {t('adminHints.form.anchor', 'Anchor (optional)')}
            {/* KS-4727/KS-4731: anchor — свободная строка, не shared-enum.
                Pattern совпадает с backend-валидацией. Сама точка
                привязки в DOM ставится через data-hint-anchor=<строка>
                в коде фронта; здесь только метка, на которую правило
                будет нацелено. KS-4822: anchor стал опциональным — если
                пуст, popover рендерится в fallback-позиции под
                header'ом. Required снято. */}
            <input
              type="text"
              pattern="^[a-z][a-z0-9-]*$"
              maxLength={64}
              value={form.anchor}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setForm((s) => ({ ...s, anchor: v }));
              }}
              placeholder="analysis-bridge-promo (leave empty for fallback popover)"
              data-testid="admin-hint-form-anchor"
            />
          </label>
          <label>
            {t('adminHints.form.placement', 'Placement')}
            <select
              value={form.placement}
              onChange={(e) =>
                setForm((s) => ({ ...s, placement: e.currentTarget.value as HintPlacement }))
              }
              data-testid="admin-hint-form-placement"
            >
              {PLACEMENTS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            {t('adminHints.form.priority', 'Priority')}
            <input
              type="number"
              min={-1000}
              max={1000}
              value={form.priority}
              onChange={(e) => setForm((s) => ({ ...s, priority: Number(e.currentTarget.value) }))}
              data-testid="admin-hint-form-priority"
            />
          </label>
          <label>
            {t('adminHints.form.cooldownSec', 'Cooldown (sec)')}
            <input
              type="number"
              min={0}
              max={31_536_000}
              value={form.cooldownSec}
              onChange={(e) => setForm((s) => ({ ...s, cooldownSec: Number(e.currentTarget.value) }))}
              data-testid="admin-hint-form-cooldown"
            />
          </label>
          <label>
            {t('adminHints.form.ttlSec', 'TTL (sec, 0 = manual)')}
            <input
              type="number"
              min={0}
              max={86_400}
              value={form.ttlSec}
              onChange={(e) => setForm((s) => ({ ...s, ttlSec: Number(e.currentTarget.value) }))}
              data-testid="admin-hint-form-ttl"
            />
          </label>
          <label>
            {t('adminHints.form.maxShows', 'Max shows')}
            <input
              type="number"
              min={1}
              max={100}
              value={form.maxShows}
              onChange={(e) => setForm((s) => ({ ...s, maxShows: Number(e.currentTarget.value) }))}
              data-testid="admin-hint-form-max-shows"
            />
          </label>
          <fieldset>
            <legend>{t('adminHints.form.targetActorTypes', 'Target actors')}</legend>
            {(['user', 'guest'] as HintActorType[]).map((a) => (
              <label key={a}>
                <input
                  type="checkbox"
                  checked={form.targetActorTypes.includes(a)}
                  onChange={(e) =>
                    setForm((s) => ({
                      ...s,
                      targetActorTypes: e.currentTarget.checked
                        ? Array.from(new Set([...s.targetActorTypes, a]))
                        : s.targetActorTypes.filter((x) => x !== a),
                    }))
                  }
                  data-testid={`admin-hint-form-actor-${a}`}
                />
                {a}
              </label>
            ))}
          </fieldset>
          <label>
            {t('adminHints.form.acceptedBy', 'Accepted by (events, comma-separated)')}
            <input
              type="text"
              value={form.acceptedBy.join(', ')}
              onChange={(e) =>
                setForm((s) => ({
                  ...s,
                  acceptedBy: e.currentTarget.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                }))
              }
              data-testid="admin-hint-form-accepted-by"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((s) => ({ ...s, enabled: e.currentTarget.checked }))}
              data-testid="admin-hint-form-enabled"
            />
            {t('adminHints.form.enabled', 'Enabled')}
          </label>
        </fieldset>

        {/* ── i18n tabs ─────────────────────────────────────── */}
        <fieldset>
          <legend>{t('adminHints.form.i18n', 'Content (i18n)')}</legend>
          <div className="admin-hint-form__i18n-tabs">
            {(['ru', 'en'] as const).map((lng) => (
              <button
                type="button"
                key={lng}
                onClick={() => setActiveLocale(lng)}
                aria-current={activeLocale === lng ? 'page' : undefined}
                data-testid={`admin-hint-form-locale-${lng}`}
              >
                {lng.toUpperCase()}
              </button>
            ))}
          </div>
          <div data-testid={`admin-hint-form-i18n-${activeLocale}`}>
            <label>
              {t('adminHints.form.i18nTitle', 'Title')}
              <input
                type="text"
                maxLength={200}
                value={form.i18n[activeLocale]?.title ?? ''}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setForm((s) => ({
                    ...s,
                    i18n: {
                      ...s.i18n,
                      [activeLocale]: {
                        ...(s.i18n[activeLocale] ?? emptyEntry()),
                        title: v,
                      },
                    },
                  }));
                }}
                data-testid={`admin-hint-form-${activeLocale}-title`}
              />
            </label>
            <label>
              {t('adminHints.form.i18nBody', 'Body')}
              <textarea
                rows={3}
                maxLength={1000}
                value={form.i18n[activeLocale]?.body ?? ''}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setForm((s) => ({
                    ...s,
                    i18n: {
                      ...s.i18n,
                      [activeLocale]: {
                        ...(s.i18n[activeLocale] ?? emptyEntry()),
                        body: v,
                      },
                    },
                  }));
                }}
                data-testid={`admin-hint-form-${activeLocale}-body`}
              />
            </label>
            <label>
              {t('adminHints.form.i18nCtaLabel', 'CTA label (optional)')}
              <input
                type="text"
                maxLength={80}
                value={form.i18n[activeLocale]?.ctaLabel ?? ''}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setForm((s) => ({
                    ...s,
                    i18n: {
                      ...s.i18n,
                      [activeLocale]: {
                        ...(s.i18n[activeLocale] ?? emptyEntry()),
                        ctaLabel: v || undefined,
                      },
                    },
                  }));
                }}
                data-testid={`admin-hint-form-${activeLocale}-cta-label`}
              />
            </label>
            <label>
              {/* KS-4822: расширенный текст инструкции. Если непустой, в
                  popover'е появляется кнопка «Подробнее» с разворотом
                  этого блока. Текст хранится per-locale. */}
              {t(
                'adminHints.form.i18nInstructionBody',
                'Instruction body (optional, expandable)',
              )}
              <textarea
                rows={4}
                maxLength={2000}
                value={form.i18n[activeLocale]?.instructionBody ?? ''}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setForm((s) => ({
                    ...s,
                    i18n: {
                      ...s.i18n,
                      [activeLocale]: {
                        ...(s.i18n[activeLocale] ?? emptyEntry()),
                        instructionBody: v || undefined,
                      },
                    },
                  }));
                }}
                data-testid={`admin-hint-form-${activeLocale}-instruction-body`}
              />
            </label>
          </div>
          <label>
            {t('adminHints.form.ctaHref', 'CTA URL (optional)')}
            <input
              type="text"
              maxLength={256}
              value={form.ctaHref}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setForm((s) => ({ ...s, ctaHref: v }));
              }}
              data-testid="admin-hint-form-cta-href"
            />
          </label>
          <label>
            {t('adminHints.form.ctaEvent', 'CTA event (optional)')}
            <input
              type="text"
              maxLength={64}
              value={form.ctaEvent}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setForm((s) => ({ ...s, ctaEvent: v }));
              }}
              data-testid="admin-hint-form-cta-event"
            />
          </label>
        </fieldset>

        {/* ── DSL editor ────────────────────────────────────── */}
        <fieldset>
          <legend>{t('adminHints.form.rule', 'Trigger rule (DSL, JSON)')}</legend>
          <textarea
            rows={12}
            value={form.ruleText}
            onChange={(e) => setForm((s) => ({ ...s, ruleText: e.currentTarget.value }))}
            onBlur={() => validateRuleSyntax()}
            data-testid="admin-hint-form-rule"
            style={{ fontFamily: 'monospace', width: '100%' }}
          />
          {ruleError && (
            <p className="admin-page__error" data-testid="admin-hint-form-rule-error">
              {ruleError}
            </p>
          )}
          <button
            type="button"
            onClick={() => void onPreview()}
            disabled={previewLoading || parsedRule === null}
            data-testid="admin-hint-form-preview-btn"
          >
            {previewLoading
              ? t('adminHints.form.previewLoading', 'Estimating…')
              : t('adminHints.form.previewBtn', 'Estimate coverage')}
          </button>
          {previewError && (
            <p className="admin-page__error" data-testid="admin-hint-form-preview-error">
              {previewError}
            </p>
          )}
          {preview && (
            <p data-testid="admin-hint-form-preview-result">
              {t(
                'adminHints.form.previewResult',
                'Matches ~{{estimate}} of {{sampled}} sampled actors (last 24h){{capped}}.',
                {
                  estimate: preview.estimate,
                  sampled: preview.sampled,
                  capped: preview.capped ? ', capped' : '',
                },
              )}
            </p>
          )}
        </fieldset>

        {saveError && (
          <p className="admin-page__error" data-testid="admin-hint-form-save-error">
            {saveError}
          </p>
        )}

        <div className="admin-page__actions">
          <button type="submit" disabled={saving} data-testid="admin-hint-form-submit">
            {saving
              ? t('adminHints.form.saving', 'Saving…')
              : t('adminHints.form.save', 'Save')}
          </button>
          <button
            type="button"
            onClick={() => navigate('/admin/hints')}
            data-testid="admin-hint-form-cancel"
          >
            {t('adminHints.form.cancel', 'Cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}

function stripEmpty(e: HintI18nEntry): HintI18nEntry {
  return {
    title: e.title.trim(),
    body: e.body.trim(),
    ...(e.ctaLabel && e.ctaLabel.trim() ? { ctaLabel: e.ctaLabel.trim() } : {}),
    ...(e.instructionBody && e.instructionBody.trim()
      ? { instructionBody: e.instructionBody.trim() }
      : {}),
  };
}
