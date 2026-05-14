import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/AuthContext';
import {
  studiesApi,
  type InvitePreviewResponse,
} from '../api/studiesApi';
import { setAuthReturnUrl } from '../utils/authReturnUrl';

/**
 * KS-2893 / ADR-060 §2.5 C5 (FC8) — `/studies/invites/:token`.
 *
 * Flow:
 *  1) Anon → `setAuthReturnUrl(<current>)` + `navigate('/login')`.
 *     После успешного логина юзер возвращается на этот же URL и
 *     попадает на ветку «auth».
 *  2) Auth → preview-запрос `studiesApi.getInvitePreview(token)`:
 *     • успех → показываем имя/описание/автора студии и кнопки
 *       Accept/Decline;
 *     • backend без preview (404 / network) → graceful-fallback:
 *       рендерим UI без метаинфы, но с активной Accept-кнопкой;
 *     • `expired=true` или `used=true` → понятная ошибка, accept
 *       заблокирован.
 *  3) Accept → `studiesApi.acceptInvite(token)` →
 *     `navigate('/studies/<slug>')`. При ошибке — inline-error
 *     (текст распознаётся: expired / used / not-found / generic).
 *  4) Decline → `navigate('/studies')`.
 */

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; preview: InvitePreviewResponse }
  | { kind: 'no-preview' } // backend не отдаёт preview, deg. fallback
  | { kind: 'error'; message: string };

function classifyError(e: unknown): string {
  const text = e instanceof Error ? e.message.toLowerCase() : '';
  if (text.includes('expired')) return 'expired';
  if (text.includes('used') || text.includes('already')) return 'used';
  if (text.includes('not found') || text.includes('404')) return 'not-found';
  return 'generic';
}

export function StudyInviteAcceptPage() {
  const { t } = useTranslation();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = useParams<{ token: string }>();

  const [previewState, setPreviewState] = useState<PreviewState>({
    kind: 'idle',
  });
  const [accepting, setAccepting] = useState<boolean>(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  // ── 1) Anon → login с returnUrl ─────────────────────────────────
  useEffect(() => {
    if (authLoading) return;
    if (user) return;
    if (!token) return;
    setAuthReturnUrl(location.pathname + location.search);
    navigate('/login');
  }, [authLoading, user, token, location, navigate]);

  // ── 2) Auth → preview ───────────────────────────────────────────
  useEffect(() => {
    if (authLoading || !user || !token) return;
    setPreviewState({ kind: 'loading' });
    studiesApi
      .getInvitePreview(token)
      .then((preview) => {
        setPreviewState({ kind: 'ready', preview });
      })
      .catch((e: unknown) => {
        const kind = classifyError(e);
        if (kind === 'not-found') {
          // Preview endpoint может быть не реализован — деградируем
          // на graceful-fallback. Реальный 404 «токен не существует»
          // вернётся уже на accept (там парсится по тексту).
          setPreviewState({ kind: 'no-preview' });
        } else if (kind === 'expired' || kind === 'used') {
          setPreviewState({
            kind: 'error',
            message:
              kind === 'expired'
                ? t(
                    'studies.invite.expired',
                    'This invite link has expired.',
                  )
                : t(
                    'studies.invite.used',
                    'This invite link has already been used.',
                  ),
          });
        } else {
          setPreviewState({
            kind: 'error',
            message: t(
              'studies.invite.previewError',
              'Failed to load invite.',
            ),
          });
        }
      });
  }, [authLoading, user, token, t]);

  // ── 3) Accept ───────────────────────────────────────────────────
  const handleAccept = useCallback(async () => {
    if (!token || accepting) return;
    setAccepting(true);
    setAcceptError(null);
    try {
      const resp = await studiesApi.acceptInvite(token);
      navigate(`/studies/${encodeURIComponent(resp.study.slug)}`);
    } catch (e) {
      const kind = classifyError(e);
      const msg =
        kind === 'expired'
          ? t('studies.invite.expired', 'This invite link has expired.')
          : kind === 'used'
            ? t(
                'studies.invite.used',
                'This invite link has already been used.',
              )
            : kind === 'not-found'
              ? t(
                  'studies.invite.notFound',
                  'Invite not found or the study has been deleted.',
                )
              : t(
                  'studies.invite.acceptError',
                  'Failed to accept invite. Please try again.',
                );
      setAcceptError(msg);
    } finally {
      setAccepting(false);
    }
  }, [token, accepting, navigate, t]);

  // ── 4) Decline ──────────────────────────────────────────────────
  const handleDecline = useCallback(() => {
    navigate('/studies');
  }, [navigate]);

  // ── Render guards ───────────────────────────────────────────────
  // Пока проверяем auth — нейтральный loader (анон-редирект придёт
  // следующим тиком useEffect).
  if (authLoading || !user) {
    return (
      <div
        className="study-invite-page"
        data-testid="study-invite-page"
        data-state="auth-pending"
      >
        <div className="studies-page__loading">
          {t('common.loading', 'Loading…')}
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div
        className="study-invite-page"
        data-testid="study-invite-page"
        data-state="bad-token"
      >
        <div
          className="studies-page__error"
          data-testid="study-invite-error"
        >
          {t('studies.invite.missingToken', 'Invite token is missing.')}
        </div>
        <Link to="/studies" className="study-page__back">
          {t('studies.backToCatalog', '← Back to studies')}
        </Link>
      </div>
    );
  }

  const previewBlocked =
    previewState.kind === 'ready' &&
    (previewState.preview.expired || previewState.preview.used);

  const previewBlockedMessage =
    previewState.kind === 'ready'
      ? previewState.preview.expired
        ? t('studies.invite.expired', 'This invite link has expired.')
        : previewState.preview.used
          ? t(
              'studies.invite.used',
              'This invite link has already been used.',
            )
          : null
      : null;

  return (
    <div
      className="study-invite-page"
      data-testid="study-invite-page"
      data-state={previewState.kind}
    >
      <header className="study-invite-page__header">
        <h1 data-testid="study-invite-title">
          {t('studies.invite.title', 'Join study')}
        </h1>
      </header>

      {previewState.kind === 'loading' && (
        <div
          className="studies-page__loading"
          data-testid="study-invite-loading"
        >
          {t('common.loading', 'Loading…')}
        </div>
      )}

      {previewState.kind === 'error' && (
        <div
          className="studies-page__error"
          data-testid="study-invite-error"
        >
          {previewState.message}
        </div>
      )}

      {(previewState.kind === 'ready' || previewState.kind === 'no-preview') && (
        <div className="study-invite-page__body">
          {previewState.kind === 'ready' && (
            <div
              className="study-invite-page__preview"
              data-testid="study-invite-preview"
            >
              <h2
                className="study-invite-page__study-name"
                data-testid="study-invite-study-name"
              >
                {previewState.preview.study.name}
              </h2>
              {previewState.preview.study.description && (
                <p
                  className="study-invite-page__study-desc"
                  data-testid="study-invite-study-desc"
                >
                  {previewState.preview.study.description}
                </p>
              )}
              {previewState.preview.study.ownerUsername && (
                <p
                  className="study-invite-page__study-owner"
                  data-testid="study-invite-study-owner"
                >
                  {t('studies.invite.invitedBy', 'Invited by')}{' '}
                  <Link
                    to={`/player/${encodeURIComponent(previewState.preview.study.ownerUsername)}`}
                  >
                    @{previewState.preview.study.ownerUsername}
                  </Link>
                </p>
              )}
            </div>
          )}
          {previewState.kind === 'no-preview' && (
            <p
              className="study-invite-page__fallback"
              data-testid="study-invite-no-preview"
            >
              {t(
                'studies.invite.noPreviewHint',
                'Press Accept to join the study you were invited to.',
              )}
            </p>
          )}

          {previewBlocked && previewBlockedMessage && (
            <div
              className="studies-page__error"
              data-testid="study-invite-blocked"
            >
              {previewBlockedMessage}
            </div>
          )}

          {acceptError && (
            <div
              className="studies-page__error"
              data-testid="study-invite-accept-error"
            >
              {acceptError}
            </div>
          )}

          <div className="study-invite-page__actions">
            <button
              type="button"
              className="study-page__action"
              data-testid="study-invite-accept"
              onClick={handleAccept}
              disabled={accepting || previewBlocked}
            >
              {accepting
                ? t('common.loading', 'Loading…')
                : t('studies.invite.accept', 'Accept')}
            </button>
            <button
              type="button"
              className="study-page__action"
              data-testid="study-invite-decline"
              onClick={handleDecline}
              disabled={accepting}
            >
              {t('studies.invite.decline', 'Decline')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

