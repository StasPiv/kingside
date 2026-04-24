import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { VideoStepPayload } from '@kingside/shared';

/**
 * VideoStep — iframe-рендер YouTube/Vimeo (L-34, KS-1796).
 *
 * # Безопасность
 *
 * Whitelist доменов жёсткий: разрешены только YouTube (`youtube.com`,
 * `youtu.be`, `youtube-nocookie.com`) и Vimeo (`vimeo.com`,
 * `player.vimeo.com`). Любой другой URL считается невалидным — iframe не
 * рендерится, показывается диагностический плейсхолдер. Та же проверка
 * дублируется backend-DTO и seed-линтером (см. L-34, §«backend»).
 *
 * # Embed-URL
 *
 * - `https://www.youtube.com/watch?v=ID[&...]`   → `https://www.youtube.com/embed/ID`
 * - `https://youtu.be/ID[?...]`                  → `https://www.youtube.com/embed/ID`
 * - `https://www.youtube.com/embed/ID`           → проверяем и отдаём как есть
 * - `https://www.youtube-nocookie.com/embed/ID`  → проверяем и отдаём как есть
 * - `https://vimeo.com/ID` или `/ID/HASH`        → `https://player.vimeo.com/video/ID[?h=HASH]`
 * - `https://player.vimeo.com/video/ID`          → проверяем и отдаём как есть
 *
 * Параметры запроса исходного URL не прокидываем в embed (никаких
 * автоплеев и прочего автоматом). `VideoSource` отдаётся под
 * параметризацию тестов и возможные будущие расширения.
 *
 * # Отметка «пройдено»
 *
 * Tracking просмотра не делаем — по ТЗ (L-34) просмотр отмечается ручной
 * кнопкой «Продолжить». Она идёт к `onStepDone()`, который `LessonPage`
 * привязывает к `useLessonProgress.markStep(id, 'done')`. Это тот же
 * паттерн, что у TextStep/QuizStep/PuzzleStep — интерфейс консистентен.
 */

export type VideoProvider = 'youtube' | 'vimeo';

export interface VideoSource {
  provider: VideoProvider;
  embedUrl: string;
}

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{6,32}$/;
const VIMEO_ID_RE = /^\d{5,20}$/;
const VIMEO_HASH_RE = /^[a-zA-Z0-9]{4,40}$/;

/**
 * Парсит внешний URL и возвращает безопасный embed. `null` — если URL
 * не принадлежит whitelist'у или не похож на видео.
 *
 * Чистая функция, экспортируется для тестов и для использования в
 * seed-линтере через `packages/shared` (если потребуется унификация).
 */
export function parseVideoUrl(raw: string | null | undefined): VideoSource | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  // ── YouTube ─────────────────────────────────────────────────────────
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    // /watch?v=ID
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      if (id && YOUTUBE_ID_RE.test(id)) {
        return { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${id}` };
      }
      return null;
    }
    // /embed/ID
    const embedMatch = u.pathname.match(/^\/embed\/([^/?#]+)$/);
    if (embedMatch && YOUTUBE_ID_RE.test(embedMatch[1])) {
      const domain = host === 'youtube-nocookie.com' ? 'www.youtube-nocookie.com' : 'www.youtube.com';
      return { provider: 'youtube', embedUrl: `https://${domain}/embed/${embedMatch[1]}` };
    }
    // /shorts/ID
    const shortsMatch = u.pathname.match(/^\/shorts\/([^/?#]+)$/);
    if (shortsMatch && YOUTUBE_ID_RE.test(shortsMatch[1])) {
      return { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${shortsMatch[1]}` };
    }
    return null;
  }

  if (host === 'youtu.be') {
    const id = u.pathname.replace(/^\//, '');
    if (id && YOUTUBE_ID_RE.test(id)) {
      return { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${id}` };
    }
    return null;
  }

  // ── Vimeo ───────────────────────────────────────────────────────────
  if (host === 'vimeo.com') {
    // /<id> или /<id>/<hash>
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const id = parts[0];
    if (!VIMEO_ID_RE.test(id)) return null;
    if (parts.length === 1) {
      return { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${id}` };
    }
    if (parts.length === 2 && VIMEO_HASH_RE.test(parts[1])) {
      return {
        provider: 'vimeo',
        embedUrl: `https://player.vimeo.com/video/${id}?h=${parts[1]}`,
      };
    }
    return null;
  }

  if (host === 'player.vimeo.com') {
    const match = u.pathname.match(/^\/video\/(\d+)$/);
    if (match && VIMEO_ID_RE.test(match[1])) {
      const hash = u.searchParams.get('h');
      if (hash && VIMEO_HASH_RE.test(hash)) {
        return { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${match[1]}?h=${hash}` };
      }
      return { provider: 'vimeo', embedUrl: `https://player.vimeo.com/video/${match[1]}` };
    }
    return null;
  }

  return null;
}

interface VideoStepProps {
  payload: VideoStepPayload;
  /**
   * Колбэк отметки шага пройденным. `LessonPage` пробрасывает сюда
   * `useLessonProgress.markStep(stepId, 'done')` через `StepRenderer`.
   */
  onStepDone?: () => void;
  /** Скрыть кнопку «Продолжить» (последний шаг → действие «Завершить урок»). */
  hideNext?: boolean;
}

export function VideoStep({ payload, onStepDone, hideNext = false }: VideoStepProps) {
  const { t } = useTranslation();
  const source = useMemo(() => parseVideoUrl(payload.url), [payload.url]);

  const title = payload.titleI18nKey ? t(payload.titleI18nKey, '') : '';

  if (!source) {
    // Невалидный URL — рендерим плейсхолдер вместо iframe. Не маскируем
    // ошибку тихо: seed-линтер backend'а такие payload'ы не должен
    // пропускать, но на фронте лучше показать явное сообщение, чем
    // сломанный iframe или запрос на сторонний домен.
    return (
      <div className="lesson-video-step" data-testid="lesson-video-step">
        {title && <h3 className="lesson-video-step__title">{title}</h3>}
        <div
          className="lesson-video-step__invalid"
          data-testid="lesson-video-step-invalid"
          role="alert"
        >
          {t('lessons.videoInvalid', 'This video link is not supported')}
        </div>
        {!hideNext && (
          <div className="lesson-video-step__actions">
            <button
              type="button"
              className="lesson-video-step__next"
              data-testid="lesson-video-step-next"
              onClick={() => onStepDone?.()}
            >
              {t('lessons.videoContinue', 'Continue')}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="lesson-video-step" data-testid="lesson-video-step">
      {title && <h3 className="lesson-video-step__title">{title}</h3>}

      <div
        className="lesson-video-step__frame"
        data-testid="lesson-video-step-frame"
        data-provider={source.provider}
      >
        <iframe
          src={source.embedUrl}
          title={title || t('lessons.stepType.video', 'Video')}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          // referrerPolicy ограничивает, что видит провайдер; для YouTube/Vimeo
          // это по-прежнему позволяет стандартный embed работать.
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
          data-testid="lesson-video-step-iframe"
        />
      </div>

      {!hideNext && (
        <div className="lesson-video-step__actions">
          <button
            type="button"
            className="lesson-video-step__next"
            data-testid="lesson-video-step-next"
            onClick={() => onStepDone?.()}
          >
            {t('lessons.videoContinue', 'Continue')}
          </button>
        </div>
      )}
    </div>
  );
}
