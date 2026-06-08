import { useEffect, useState } from 'react';
import {
  LiveAnalysisEvents,
  type LectureDisabledTool,
  type LectureToolsChangedEvent,
} from '@kingside/shared';
import { liveAnalysisSocket } from '../socket';

/**
 * KS-3905 / ADR-117 §3 (шаг C01). Источник политики «какие инструменты
 * отключены тренером для учеников» на стороне зрителя live-лекции.
 *
 * Поведение:
 *  1. Начальное значение хук получает извне (`initial`): родитель
 *     передаёт `lectureDisabledTools` из `LiveAnalysisResponse`
 *     (REST-снапшот при mount-фазе) или из `LiveAnalysisSyncSnapshot`
 *     (если уже подписан на WS и получил sync). `undefined`/`null`
 *     трактуются как «политика ещё не известна» — возвращаем пустой
 *     массив, чтобы UI не упал на `.includes`/`.map`.
 *  2. Если `initial` изменился между рендерами (например, дождались
 *     REST-ответа или пришёл sync после reconnect-а) — синхронизируем
 *     локальное состояние. Сравнение по ссылке: родитель обновляет
 *     массив только при реальной смене.
 *  3. Пока `slug` валиден, хук подписан на WS-событие
 *     `live-analysis:lecture-tools` (`LiveAnalysisEvents.LECTURE_TOOLS`).
 *     Сервер шлёт `LectureToolsChangedEvent` со ПОЛНЫМ новым набором
 *     (не дельта, см. KS-3896). Cross-room защита по `payload.slug`:
 *     глобальный `liveAnalysisSocket` в редких сценариях (быстрое
 *     переключение slug-а) может доставить событие чужой комнаты —
 *     его игнорируем.
 *  4. Отписка от события — в cleanup-функции effect-а: при смене slug
 *     и при unmount. Сам socket НЕ disconnect-ится (он глобальный, см.
 *     `useLiveAnalysisSocket`).
 *
 * Возвращает `policy: LectureDisabledTool[]` — список запрещённых
 * ученикам инструментов. Пустой массив = всё разрешено.
 *
 * Хук не выполняет REST-запросов и не emit-ит WS-сообщений — это
 * чистая обвязка над одним server→client event-ом. Контракт намеренно
 * «тонкий», чтобы потребитель C02 сам выбирал источник начального
 * значения (LiveAnalysisResponse через REST vs. snapshot из sync).
 */
export function useLectureToolsPolicy(
  slug: string | null | undefined,
  initial?: LectureDisabledTool[] | null,
): LectureDisabledTool[] {
  const [policy, setPolicy] = useState<LectureDisabledTool[]>(
    () => initial ?? [],
  );

  // Синхронизация с `initial` при его смене. Эффект сработает в том
  // числе при первом монте (initial-ссылка — та же, что в useState),
  // но `setPolicy` с тем же массивом дополнительный рендер не вызовет:
  // React сравнивает старое и новое значение через Object.is.
  useEffect(() => {
    setPolicy(initial ?? []);
  }, [initial]);

  useEffect(() => {
    if (!slug) return;
    const handler = (payload: LectureToolsChangedEvent) => {
      if (payload?.slug !== slug) return;
      setPolicy(payload.disabledTools);
    };
    liveAnalysisSocket.on(LiveAnalysisEvents.LECTURE_TOOLS, handler);
    return () => {
      liveAnalysisSocket.off(LiveAnalysisEvents.LECTURE_TOOLS, handler);
    };
  }, [slug]);

  return policy;
}
