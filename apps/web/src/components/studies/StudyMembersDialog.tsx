import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  studiesApi,
  type StudyMemberDto,
} from '../../api/studiesApi';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

/**
 * KS-2892 / ADR-060 §2.5 C1, C5 (FC7) — модалка управления соавторами
 * студии.
 *
 * Открывается только владельцем (StudyPage сам прячет триггер). Внутри:
 *  • список members c ролями (owner / contributor) — backend возвращает
 *    owner первым;
 *  • кнопка «Remove» рядом с каждым contributor'ом;
 *  • поле «username» + «Invite» → POST /studies/:slug/members;
 *  • кнопка «Generate invite link» → POST /studies/:slug/invite-link;
 *    при успехе показываем сгенерированный URL и кнопку «Copy link».
 *
 * Все операции — оптимистичные только в UI-смысле (loading-flag на
 * соответствующем кейсе); state members перечитывается из ответа
 * backend (POST /members возвращает обновлённый список — `data`
 * заменяется целиком).
 */

interface StudyMembersDialogProps {
  slug: string;
  /** Хост студии (для построения invite-URL). По умолчанию — текущий. */
  origin?: string;
  onClose: () => void;
}

export function StudyMembersDialog({
  slug,
  origin,
  onClose,
}: StudyMembersDialogProps) {
  const { t } = useTranslation();
  const copyToClipboard = useCopyToClipboard();

  const [members, setMembers] = useState<StudyMemberDto[]>([]);
  const [listLoading, setListLoading] = useState<boolean>(false);
  const [listError, setListError] = useState<string | null>(null);

  const [username, setUsername] = useState<string>('');
  const [inviteSubmitting, setInviteSubmitting] = useState<boolean>(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [linkBusy, setLinkBusy] = useState<boolean>(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkExpiresAt, setLinkExpiresAt] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState<boolean>(false);

  const reload = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const resp = await studiesApi.listMembers(slug);
      setMembers(resp.members);
    } catch {
      setListError(
        t('studies.members.errorLoad', 'Failed to load members.'),
      );
    } finally {
      setListLoading(false);
    }
  }, [slug, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleInvite = useCallback(async () => {
    const trimmed = username.trim();
    if (!trimmed || inviteSubmitting) return;
    setInviteSubmitting(true);
    setInviteError(null);
    setInviteSuccess(null);
    try {
      const resp = await studiesApi.inviteMember(slug, {
        userIdOrUsername: trimmed,
      });
      setMembers(resp.members);
      setInviteSuccess(
        t('studies.members.inviteOk', 'Invited {{user}}.', { user: trimmed }),
      );
      setUsername('');
    } catch (e) {
      setInviteError(
        e instanceof Error && e.message
          ? e.message
          : t(
              'studies.members.inviteError',
              'Failed to invite. Check the username and try again.',
            ),
      );
    } finally {
      setInviteSubmitting(false);
    }
  }, [slug, username, inviteSubmitting, t]);

  const handleRemove = useCallback(
    async (userId: string) => {
      if (removingId) return;
      setRemovingId(userId);
      setRemoveError(null);
      try {
        await studiesApi.removeMember(slug, userId);
        setMembers((prev) => prev.filter((m) => m.userId !== userId));
      } catch (e) {
        setRemoveError(
          e instanceof Error && e.message
            ? e.message
            : t('studies.members.removeError', 'Failed to remove member.'),
        );
      } finally {
        setRemovingId(null);
      }
    },
    [slug, removingId, t],
  );

  const handleGenerateLink = useCallback(async () => {
    if (linkBusy) return;
    setLinkBusy(true);
    setLinkError(null);
    setLinkCopied(false);
    try {
      const resp = await studiesApi.createInviteLink(slug);
      // Если backend отдал готовый URL (поле `url`) — используем его;
      // иначе собираем из origin + token. Это позволит embed-страницам
      // прокинуть нужный хост через props без хардкодинга.
      const base = origin ?? window.location.origin;
      const url = resp.url ?? `${base}/studies/invites/${resp.token}`;
      setLinkUrl(url);
      setLinkExpiresAt(resp.expiresAt);
    } catch (e) {
      setLinkError(
        e instanceof Error && e.message
          ? e.message
          : t(
              'studies.members.linkError',
              'Failed to generate invite link.',
            ),
      );
    } finally {
      setLinkBusy(false);
    }
  }, [slug, origin, linkBusy, t]);

  const handleCopyLink = useCallback(async () => {
    if (!linkUrl) return;
    const ok = await copyToClipboard(linkUrl);
    if (ok) {
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2000);
    }
  }, [linkUrl, copyToClipboard]);

  return (
    <div
      className="import-pgn-dialog__backdrop"
      role="dialog"
      aria-modal="true"
      data-testid="study-members-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="import-pgn-dialog">
        <header className="import-pgn-dialog__header">
          <h2>{t('studies.members.title', 'Members')}</h2>
          <button
            type="button"
            className="import-pgn-dialog__close"
            data-testid="study-members-dialog-close"
            aria-label={t('common.close', 'Close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {/* ── Список ──────────────────────────────────────────── */}
        {listLoading ? (
          <div data-testid="study-members-loading">
            {t('common.loading', 'Loading…')}
          </div>
        ) : listError ? (
          <div
            className="import-pgn-dialog__error"
            data-testid="study-members-list-error"
          >
            {listError}
          </div>
        ) : (
          <ul
            className="study-members-list"
            data-testid="study-members-list"
          >
            {members.map((m) => (
              <li
                key={m.userId}
                data-testid={`study-members-item-${m.userId}`}
                data-role={m.role}
                className="study-members-list__item"
              >
                <span className="study-members-list__name">
                  @{m.username ?? m.userId.slice(0, 8)}
                </span>
                <span
                  className="study-members-list__role"
                  data-role={m.role}
                >
                  {m.role === 'owner'
                    ? t('studies.members.roleOwner', 'Owner')
                    : t('studies.members.roleContributor', 'Contributor')}
                </span>
                {m.role !== 'owner' && (
                  <button
                    type="button"
                    className="study-page__action study-page__action--danger"
                    data-testid={`study-members-remove-${m.userId}`}
                    onClick={() => void handleRemove(m.userId)}
                    disabled={removingId === m.userId}
                  >
                    {removingId === m.userId
                      ? t('studies.members.removing', 'Removing…')
                      : t('studies.members.remove', 'Remove')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {removeError && (
          <div
            className="import-pgn-dialog__error"
            data-testid="study-members-remove-error"
          >
            {removeError}
          </div>
        )}

        {/* ── Invite by username ─────────────────────────────── */}
        <fieldset
          className="create-study-dialog__field"
          data-testid="study-members-invite-username"
        >
          <legend className="create-study-dialog__label">
            {t('studies.members.inviteByUsername', 'Invite by username')}
          </legend>
          <div
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          >
            <input
              type="text"
              className="create-study-dialog__input"
              data-testid="study-members-invite-input"
              value={username}
              disabled={inviteSubmitting}
              maxLength={50}
              placeholder={t('studies.members.usernamePlaceholder', 'username')}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleInvite();
                }
              }}
            />
            <button
              type="button"
              className="study-page__action"
              data-testid="study-members-invite-submit"
              onClick={handleInvite}
              disabled={inviteSubmitting || !username.trim()}
            >
              {inviteSubmitting
                ? t('common.loading', 'Loading…')
                : t('studies.members.invite', 'Invite')}
            </button>
          </div>
          {inviteSuccess && (
            <p
              className="study-members-list__success"
              data-testid="study-members-invite-success"
            >
              {inviteSuccess}
            </p>
          )}
          {inviteError && (
            <p
              className="import-pgn-dialog__error"
              data-testid="study-members-invite-error"
            >
              {inviteError}
            </p>
          )}
        </fieldset>

        {/* ── Invite-link ─────────────────────────────────────── */}
        <fieldset
          className="create-study-dialog__field"
          data-testid="study-members-invite-link"
        >
          <legend className="create-study-dialog__label">
            {t('studies.members.inviteLink', 'Invite link (7-day TTL)')}
          </legend>
          {linkUrl ? (
            <div
              data-testid="study-members-invite-link-url"
              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
            >
              <input
                type="text"
                readOnly
                className="create-study-dialog__input"
                value={linkUrl}
                data-testid="study-members-invite-link-input"
                style={{ flex: '1 1 240px' }}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                className="study-page__action"
                data-testid="study-members-invite-link-copy"
                onClick={handleCopyLink}
              >
                {linkCopied
                  ? t('studies.members.copied', 'Copied!')
                  : t('studies.members.copy', 'Copy')}
              </button>
              <button
                type="button"
                className="study-page__action"
                data-testid="study-members-invite-link-regenerate"
                onClick={handleGenerateLink}
                disabled={linkBusy}
              >
                {linkBusy
                  ? t('common.loading', 'Loading…')
                  : t('studies.members.regenerate', 'Regenerate')}
              </button>
              {linkExpiresAt && (
                <span
                  className="study-members-list__expires"
                  data-testid="study-members-invite-link-expires"
                >
                  {t('studies.members.expiresAt', 'Expires {{date}}', {
                    date: new Date(linkExpiresAt).toLocaleDateString(),
                  })}
                </span>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="study-page__action"
              data-testid="study-members-invite-link-generate"
              onClick={handleGenerateLink}
              disabled={linkBusy}
            >
              {linkBusy
                ? t('common.loading', 'Loading…')
                : t(
                    'studies.members.generateLink',
                    'Generate invite link',
                  )}
            </button>
          )}
          {linkError && (
            <p
              className="import-pgn-dialog__error"
              data-testid="study-members-invite-link-error"
            >
              {linkError}
            </p>
          )}
        </fieldset>

        <div className="import-pgn-dialog__actions">
          <button
            type="button"
            className="study-page__action"
            data-testid="study-members-dialog-done"
            onClick={onClose}
          >
            {t('common.close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
}
