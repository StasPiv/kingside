import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
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
 * KS-2674: переехала из шапки в action-bar под доской (desktop) и в
 * overflow-меню (mobile). Чтобы открыть popup из mobile-меню — родитель
 * получает ref на компонент и вызывает `ref.current?.open()`. Trigger
 * сам остаётся видимым на desktop, на mobile скрыт через CSS — popup
 * рендерится из `display:flex` родителя `.analysis-share`, поэтому
 * остаётся visible даже когда сам триггер `display:none`.
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

export interface ShareAnalysisButtonHandle {
  open: () => void;
  close: () => void;
  toggle: () => void;
}

type ToastTone = 'success' | 'error' | 'info';
interface ToastState {
  message: string;
  tone: ToastTone;
}

export const ShareAnalysisButton = forwardRef<
  ShareAnalysisButtonHandle,
  ShareAnalysisButtonProps
>(function ShareAnalysisButton(
  { analysisId, initialIsPublic, onPublicChanged },
  handleRef,
) {
  const { t } = useTranslation();
  const { share } = useSavedAnalyses();
  const copyToClipboard = useCopyToClipboard();

  const [open, setOpen] = useState(false);
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  // KS-2674: даём родителю программное управление popup'ом — нужно
  // чтобы пункт «Share» в overflow-меню (mobile) открывал тот же popup,
  // не дублируя триггер.
  useImperativeHandle(
    handleRef,
    () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((cur) => !cur),
    }),
    [],
  );

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
        className="analysis-share__trigger analysis-export-btn"
        data-testid="analysis-share-trigger"
        onClick={() => setOpen((cur) => !cur)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('analysis.share.button', 'Share')}
        title={t('analysis.share.button', 'Share')}
      >
        {/* KS-2671: иконка вместо текста (стиль icon-action из
            KS-2654/2670). Material-style «share» glyph: три точки,
            соединённые линиями. tooltip из aria-label через CSS-
            ::after, дублирующий нативный title. */}
        <svg
          className="analysis-share__icon"
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="currentColor"
          width="14"
          height="14"
        >
          <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" />
        </svg>
        <span className="analysis-share__trigger-text">
          {t('analysis.share.button', 'Share')}
        </span>
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
});
