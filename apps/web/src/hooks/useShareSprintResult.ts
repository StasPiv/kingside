import { useCallback, useState } from 'react';

/**
 * KS-2251 (ADR-035 §11, Drills E6) — share-image для sprint result.
 *
 * Генерирует PNG-картинку 1200×630 (OG-формат) с результатом sprint'а
 * через offscreen `<canvas>` → blob → File → `navigator.share` с
 * fallback'ом «download blob + copy URL».
 *
 * Tex-only fallback (когда canvas недоступен — SSR/jsdom): отдаём blob
 * пустого размера и пытаемся share только текста+URL.
 *
 * # UTM
 *
 * Shared URL = `<origin>/drills/sprint?utm_source=share&utm_medium=
 * sprint-result&utm_campaign=drills`. Параметры зафиксированы в задаче
 * KS-2251 (marketing).
 *
 * # Status
 *
 *  'idle'        — кнопка не нажималась / ничего не идёт.
 *  'preparing'   — рендерим canvas, генерим blob.
 *  'shared'      — `navigator.share()` вернул успех.
 *  'copied'      — fallback: blob скачан + URL в clipboard.
 *  'failed'      — браузер не позволил ни share, ни download/copy.
 */

export interface SprintShareInput {
  score: number;
  /** [0..1]. */
  accuracy: number;
  /** Длительность сессии (читабельная строка типа "3 мин"). */
  durationLabel: string;
  /** Чел.-имя drill-set'а ("Все 7 типов"). */
  setLabel: string;
}

export type ShareStatus = 'idle' | 'preparing' | 'shared' | 'copied' | 'failed';

export interface ShareTexts {
  /** Названия / placeholder-копирование, пробрасывается из i18n. */
  title: string;
  /** Финальный текст с подставленными score/accuracy. */
  text: string;
  /** Имя файла blob'а. */
  fileName: string;
}

const CANVAS_W = 1200;
const CANVAS_H = 630;
const SHARE_URL_PATH = '/drills/sprint';
const UTM = '?utm_source=share&utm_medium=sprint-result&utm_campaign=drills';

/** Собирает абсолютный URL для шаринга с UTM-метками. */
export function buildShareUrl(origin?: string): string {
  const base =
    origin ??
    (typeof window !== 'undefined' ? window.location.origin : 'https://kingside.site');
  return `${base.replace(/\/$/, '')}${SHARE_URL_PATH}${UTM}`;
}

/**
 * Рендерит карточку результата на переданный canvas. Вынесено в
 * самостоятельную функцию, чтобы можно было unit-тестировать без хука
 * (canvas mock'ается в тесте).
 */
export function renderSprintResultCanvas(
  canvas: HTMLCanvasElement,
  data: SprintShareInput,
): boolean {
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  // Фон — тёмно-синий градиент.
  const grad = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(1, '#1e293b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Логотип / brand.
  ctx.fillStyle = '#f1f5f9';
  ctx.font = 'bold 56px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('Kingside', 80, 80);
  ctx.font = '500 28px sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Drill Sprint', 80, 150);

  // Score — крупно по центру.
  ctx.fillStyle = '#22d3ee';
  ctx.font = 'bold 220px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(data.score), CANVAS_W / 2, 240);

  // Accuracy — под score.
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '500 40px sans-serif';
  const pct = Math.round(Math.max(0, Math.min(1, data.accuracy)) * 100);
  ctx.fillText(`${pct}% accuracy`, CANVAS_W / 2, 480);

  // Метаданные снизу: длительность + drill-set.
  ctx.fillStyle = '#94a3b8';
  ctx.font = '400 28px sans-serif';
  ctx.fillText(`${data.durationLabel} · ${data.setLabel}`, CANVAS_W / 2, 540);

  // CTA-полоса справа сверху.
  ctx.textAlign = 'right';
  ctx.fillStyle = '#fbbf24';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('kingside.site', CANVAS_W - 80, 90);

  return true;
}

/** Превращает canvas в Blob (через toBlob — Promise-обёртка). */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = 'image/png',
): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), type);
  });
}

/** Fallback: скачивает blob под именем filename через временный <a download>. */
function downloadBlob(blob: Blob, fileName: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* ignore — fallback ниже */
  }
  // Fallback execCommand для старых браузеров. Не критично если не сработает.
  return false;
}

interface ShareOpts {
  data: SprintShareInput;
  texts: ShareTexts;
  /** Канвас, на котором рендерим. Может быть offscreen (`document.createElement`). */
  canvas?: HTMLCanvasElement;
  /** Origin для shared URL — для тестов. */
  origin?: string;
}

export interface UseShareSprintResultReturn {
  status: ShareStatus;
  share: (opts: ShareOpts) => Promise<void>;
  reset: () => void;
}

export function useShareSprintResult(): UseShareSprintResultReturn {
  const [status, setStatus] = useState<ShareStatus>('idle');

  const reset = useCallback(() => setStatus('idle'), []);

  const share = useCallback(async (opts: ShareOpts) => {
    setStatus('preparing');
    const canvas =
      opts.canvas ??
      (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    if (!canvas) {
      // SSR / jsdom без canvas: пробуем только текст-share.
      setStatus('failed');
      return;
    }
    const ok = renderSprintResultCanvas(canvas, opts.data);
    if (!ok) {
      setStatus('failed');
      return;
    }
    const blob = await canvasToBlob(canvas);
    const url = buildShareUrl(opts.origin);
    const file = blob ? new File([blob], opts.texts.fileName, { type: 'image/png' }) : null;

    // Native Share API: пробуем с files, потом без.
    const nav: Navigator | undefined =
      typeof navigator !== 'undefined' ? navigator : undefined;
    const canShareFiles =
      !!nav &&
      typeof nav.canShare === 'function' &&
      file !== null &&
      nav.canShare({ files: [file] });

    if (nav && typeof nav.share === 'function') {
      try {
        if (canShareFiles && file) {
          await nav.share({
            title: opts.texts.title,
            text: opts.texts.text,
            url,
            files: [file],
          });
        } else {
          await nav.share({
            title: opts.texts.title,
            text: opts.texts.text,
            url,
          });
        }
        setStatus('shared');
        return;
      } catch {
        // AbortError или DataError — fallback ниже.
      }
    }

    // Fallback: download + copy URL.
    if (blob) downloadBlob(blob, opts.texts.fileName);
    const copied = await copyToClipboard(`${opts.texts.text} ${url}`);
    setStatus(copied || blob ? 'copied' : 'failed');
  }, []);

  return { status, share, reset };
}
