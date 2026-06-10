/**
 * KS-4042. Источник «скрыты ли метрики у учеников» на стороне зрителя
 * живой лекции. По образцу `useLectureToolsPolicy` (KS-3905):
 *
 *  1. Начальное значение хук получает извне (`initial`): родитель
 *     передаёт `lectureHideMetricsTab` из `LiveAnalysisResponse` (REST
 *     snapshot при mount-фазе). `undefined`/`null` → `false`
 *     (по умолчанию метрики видны; backend на новом контракте всегда
 *     присылает поле, но клиенты на старом snapshot'е могут получить
 *     undefined — fallback нужен).
 *  2. Если `initial` изменился между рендерами (REST повторно дотянул
 *     snapshot, например после переподключения), синхронизируем
 *     локальное состояние.
 *  3. Пока `slug` валиден, хук подписан на WS-событие
 *     `live-analysis:lecture-tools` (`LiveAnalysisEvents.LECTURE_TOOLS`).
 *     Сервер шлёт `LectureToolsChangedEvent` с полным новым набором —
 *     включая обязательное поле `hideMetricsTab` (KS-4041). Cross-room
 *     защита по `payload.slug` — глобальный socket в редких сценариях
 *     может доставить событие чужой комнаты, его игнорируем.
 *  4. Отписка в cleanup-функции effect-а при смене slug / unmount.
 *
 * Возвращает `boolean`. `true` означает «зрителю-ученику блок Метрик
 * скрыт» — `AnalysisPage` использует это в проп `hideMetricsForViewers`.
 */
import { useEffect, useState } from 'react';
import {
  LiveAnalysisEvents,
  type LectureToolsChangedEvent,
} from '@kingside/shared';
import { liveAnalysisSocket } from '../socket';

export function useLectureHideMetricsTab(
  slug: string | null | undefined,
  initial?: boolean | null,
): boolean {
  const [value, setValue] = useState<boolean>(() => Boolean(initial));

  useEffect(() => {
    setValue(Boolean(initial));
  }, [initial]);

  useEffect(() => {
    if (!slug) return;
    const handler = (payload: LectureToolsChangedEvent) => {
      if (payload?.slug !== slug) return;
      setValue(Boolean(payload.hideMetricsTab));
    };
    liveAnalysisSocket.on(LiveAnalysisEvents.LECTURE_TOOLS, handler);
    return () => {
      liveAnalysisSocket.off(LiveAnalysisEvents.LECTURE_TOOLS, handler);
    };
  }, [slug]);

  return value;
}
