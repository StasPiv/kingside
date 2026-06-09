import { useEffect, useState } from 'react';
import type { LiveAnalysisResponse } from '@kingside/shared';
import { api } from '../api';

/**
 * KS-3863. Найти лекцию, привязанную к live-analysis slug-у.
 *
 * Backend сейчас не отдаёт `lectureId` ни в `LiveAnalysisResponse`,
 * ни через отдельный публичный эндпоинт по slug-у. Чтобы получить
 * `lectureId` (нужен для `LecturePublisherControls` /
 * `LectureAudioListener` / `LectureRecordingBadge`), хук делает два
 * запроса:
 *  1. `GET /live-analyses/:slug` — для `id` и `ownerUsername`.
 *  2. `GET /coaches/:ownerUsername/lectures?status=live` — listing
 *     активных лекций тренера; фильтруем по `liveAnalysisId === la.id`.
 *
 * Хук «спит» при `slug = null/undefined`. Если любая операция падает
 * или подходящая лекция не найдена, возвращает `null` — потребитель
 * просто не показывает компоненты лекции.
 *
 * Минимальная защита от устаревшего ответа: при смене slug-а старый
 * ответ игнорируется через `cancelled`-флаг.
 */

export interface LectureLookupResult {
  /** UUID лекции. */
  lectureId: string;
  /** `startedAt` лекции в ISO-8601 (для `recordingStartedAtClient`). */
  startedAt: string | null;
  /** `username` владельца трансляции (полезно для UI/диагностики). */
  ownerUsername: string | null;
}

interface CoachLectureLite {
  id: string;
  liveAnalysisId: string | null;
  status: 'scheduled' | 'live' | 'recorded' | 'cancelled';
  startedAt: string | null;
}

export function useLectureLookupBySlug(
  slug: string | null | undefined,
): LectureLookupResult | null {
  const [result, setResult] = useState<LectureLookupResult | null>(null);

  useEffect(() => {
    setResult(null);
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const la = await api.get<LiveAnalysisResponse>(
          `/live-analyses/${encodeURIComponent(slug)}`,
        );
        if (cancelled) return;
        if (!la.ownerUsername) return;
        // KS-4010. Раньше шли с `?status=live` — если backend-фильтр
        // не маппил параметр (возвращал пустой список) или лекция
        // переходила в статус `recorded` сразу после запроса, у
        // зрителя пропадали все индикаторы лекции (включая чат
        // KS-4009). Теперь забираем все лекции тренера и фильтруем
        // в памяти: ищем именно по `liveAnalysisId === la.id` и
        // дополнительно требуем `status === 'live'` — это устраняет
        // зависимость от точной семантики query-фильтра на бэкенде.
        const list = await api.get<CoachLectureLite[]>(
          `/coaches/${encodeURIComponent(la.ownerUsername)}/lectures`,
        );
        if (cancelled) return;
        const match =
          list.find(
            (l) => l.liveAnalysisId === la.id && l.status === 'live',
          ) ?? null;
        if (!match) {
          setResult(null);
          return;
        }
        setResult({
          lectureId: match.id,
          startedAt: match.startedAt,
          ownerUsername: la.ownerUsername,
        });
      } catch {
        if (!cancelled) setResult(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return result;
}
