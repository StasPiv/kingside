import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSavedAnalyses } from '../../hooks/useSavedAnalyses';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

/**
 * KS-2666 / ADR-051 §3 — кнопка «Поделиться» на странице анализа.
 *
 * Видна автору анализа. По клику открывает popup с:
 *  - текущим состоянием `isPublic`;
 *  - публичной ссылкой `${origin}/analysis/public/<id>` (показана
 *    всегда — даже если приватный, чтобы пользователь видел, какая
 *    ссылка появится после toggle);
 *  - кнопкой Copy link;
 *  - кнопкой toggle (Make public / Make private).
 *
 * Backend: `PATCH /analyses/:id/share { isPublic }` — KS-2601.
 *
 * Тосты — отдельный inline-блок внутри popup'а (не плодим сторонний
 * toaster). Auto-hide через 2.5с.
 */

interface ShareAnalysisButtonProps {
  analysisId: string;
  /**
   * Текущий `isPublic` (из загруженного анализа). Родитель передаёт
   * свежее значение; popup использует его как initial. После toggle —
   * локальный state в этом компоненте, родитель синхронизируется
   * через `onPublicChanged` (опционально, можно не использовать).
   */
  initialIsPublic: boolean;
  onPublicChanged?: (next: boolean) => void;
}

type ToastTone = 'success' | 'error' | 'info';
interface ToastState {
  message: string;
  tone: ToastTone;
}

export function ShareAnalysisButton({
  analysisId,
  initialIsPublic,
  onPublicChanged,
}: ShareAnalysisButtonProps) {
  const { t } = useTranslation();
  const { share } = useSavedAnalyses();
  const copyToClipboard = useCopyToClipboard();

  const [open, setOpen] = useState(false);
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  // Синхронизация: если родитель прислал новый initialIsPublic
  // (например, после reload), берём его — нужно чтобы popup был
  // правильно проинициализирован при повторном открытии.
  useEffect(() => {
    setIsPublic(initialIsPublic);
  }, [initialIsPublic]);

  // Закрытие popup'а по клику вне / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && popupRef.current && !popupRef.current.contains(target)) {
        // Кнопка-триггер тоже находится внутри обёртки (popupRef
        // root), поэтому clicks по самой кнопке не закрывают popup.
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const showToast = useCallback((tone: ToastTone, message: string) => {
    setToast({ tone, message });
    window.setTimeout(() => {
      setToast((cur) =>
        cur && cur.message === message ? null : cur,
      );
    }, 2500);
  }, []);

  const publicUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/analysis/public/${analysisId}`
      : `/analysis/public/${analysisId}`;

  const handleToggle = useCallback(async () => {
    if (pending) return;
    setPending(true);
    const next = !isPublic;
    try {
      const updated = await share(analysisId, next);
      // KS-2666: shared-тип AnalysisResponse не описывает `isPublic`
      // (backend поле есть, KS-2601). Cast'им читаемое значение —
      // расхождение между shared и фактическим API будет закрыто
      // отдельной задачей.
      const updatedIsPublic =
        (updated as { isPublic?: boolean }).isPublic ?? next;
      setIsPublic(updatedIsPublic);
      onPublicChanged?.(updatedIsPublic);
      showToast(
        'success',
        next
          ? t(
              'analysis.share.toastMadePublic',
              'Analysis is now public',
            )
          : t(
              'analysis.share.toastMadePrivate',
              'Analysis is now private',
            ),
      );
    } catch {
      showToast(
        'error',
        t('analysis.share.toastError', 'Could not update visibility'),
      );
    } finally {
      setPending(false);
    }
  }, [analysisId, isPublic, onPublicChanged, pending, share, showToast, t]);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(publicUrl);
    if (ok) {
      showToast(
        'success',
        isPublic
          ? t('analysis.share.toastLinkCopied', 'Link copied')
          : t(
              'analysis.share.toastLinkCopiedPrivate',
              'Link copied. Make public to share with others.',
            ),
      );
    } else {
      showToast(
        'error',
        t('analysis.share.toastCopyError', 'Could not copy link'),
      );
    }
  }, [copyToClipboard, isPublic, publicUrl, showToast, t]);

  return (
    <div
      className="analysis-share"
      data-testid="analysis-share-root"
      ref={popupRef}
    >
      <button
        type="button"
        className="analysis-share__trigger"
        data-testid="analysis-share-trigger"
        onClick={() => setOpen((cur) => !cur)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {t('analysis.share.button', 'Share')}
      </button>
      {open && (
        <div
          className="analysis-share__popup"
          role="dialog"
          aria-label={t('analysis.share.popupLabel', 'Share analysis')}
          data-testid="analysis-share-popup"
          data-state={isPublic ? 'public' : 'private'}
        >
          <div className="analysis-share__status">
            <span
              className={`analysis-share__badge analysis-share__badge--${
                isPublic ? 'public' : 'private'
              }`}
              data-testid="analysis-share-state"
            >
              {isPublic
                ? t('analysis.share.statusPublic', 'Public')
                : t('analysis.share.statusPrivate', 'Private')}
            </span>
            <p className="analysis-share__hint">
              {isPublic
                ? t(
                    'analysis.share.hintPublic',
                    'Anyone with the link can view this analysis (read-only).',
                  )
                : t(
                    'analysis.share.hintPrivate',
                    'Only you can see this analysis. Make it public to share.',
                  )}
            </p>
          </div>
          <label className="analysis-share__url-row">
            <span className="analysis-share__url-label">
              {t('analysis.share.urlLabel', 'Public link')}
            </span>
            <input
              type="text"
              readOnly
              value={publicUrl}
              className="analysis-share__url"
              data-testid="analysis-share-url"
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <div className="analysis-share__actions">
            <button
              type="button"
              className="analysis-share__copy"
              data-testid="analysis-share-copy"
              onClick={() => void handleCopy()}
            >
              {t('analysis.share.copy', 'Copy link')}
            </button>
            <button
              type="button"
              className="analysis-share__toggle"
              data-testid="analysis-share-toggle"
              onClick={() => void handleToggle()}
              disabled={pending}
              aria-pressed={isPublic}
            >
              {pending
                ? t('analysis.share.updating', 'Updating…')
                : isPublic
                  ? t('analysis.share.makePrivate', 'Make private')
                  : t('analysis.share.makePublic', 'Make public')}
            </button>
          </div>
          {toast && (
            <p
              className={`analysis-share__toast analysis-share__toast--${toast.tone}`}
              role="status"
              aria-live="polite"
              data-testid="analysis-share-toast"
              data-tone={toast.tone}
            >
              {toast.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
