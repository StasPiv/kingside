import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * KS-3190 (ADR-073 §7 F3): простой bottom-sheet с тремя snap-точками.
 *
 * Контракт хука минимален:
 *  - `snap` — текущее состояние `'peek' | 'half' | 'full'`;
 *  - `setSnap` — программно поменять snap (например, tap по табу
 *    переключает sheet в `half`);
 *  - `handleProps` — пропы для drag-ручки sheet'а (`onPointerDown`,
 *    `onPointerMove`, `onPointerUp`). Жест считается одним из:
 *      - drag вверх > `SWIPE_DELTA_PX` → следующая snap-точка вверх
 *        (peek → half → full);
 *      - drag вниз > `SWIPE_DELTA_PX` → следующая вниз
 *        (full → half → peek);
 *      - tap (delta ≤ threshold) → переключение на one-up (по
 *        кругу peek → half → full → peek). Это даёт совместимый UX
 *        для устройств без pointermove (например click без drag'а).
 *  - `nextSnap` — служебный геттер на следующую точку (для теста и
 *    кнопочного управления, если потребуется).
 *
 * Хук не управляет стилями — это задача компонента (CSS-var
 * `--lesson-sheet-height` или data-attribute `data-snap`). Это
 * позволяет легко переиспользовать в будущем (например, на странице
 * `/precision/history` или внутри Workshop).
 *
 * Намеренно избегаем зависимости от внешних библиотек жестов: реализация
 * на нативных pointer-events. На touch-устройствах `pointer*`-события
 * стабильно работают начиная с iOS 13 / Android 4+, что покрывает все
 * целевые устройства проекта.
 */

export type BottomSheetSnap = 'peek' | 'half' | 'full';

const SNAP_ORDER: readonly BottomSheetSnap[] = ['peek', 'half', 'full'];

/** Минимальное вертикальное смещение для интерпретации жеста как swipe. */
const SWIPE_DELTA_PX = 24;

interface UseBottomSheetOptions {
  /** Стартовая snap-точка. По умолчанию 'peek'. */
  initial?: BottomSheetSnap;
}

interface BottomSheetHandleProps {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}

export interface UseBottomSheetResult {
  snap: BottomSheetSnap;
  setSnap: (next: BottomSheetSnap) => void;
  /** Циклический «следующий» переход — `peek→half→full→peek`. */
  cycleSnap: () => void;
  handleProps: BottomSheetHandleProps;
}

function indexOf(snap: BottomSheetSnap): number {
  return SNAP_ORDER.indexOf(snap);
}

function snapUp(curr: BottomSheetSnap): BottomSheetSnap {
  const i = indexOf(curr);
  return SNAP_ORDER[Math.min(SNAP_ORDER.length - 1, i + 1)];
}

function snapDown(curr: BottomSheetSnap): BottomSheetSnap {
  const i = indexOf(curr);
  return SNAP_ORDER[Math.max(0, i - 1)];
}

export function useBottomSheet(
  options: UseBottomSheetOptions = {},
): UseBottomSheetResult {
  const { initial = 'peek' } = options;
  const [snap, setSnapState] = useState<BottomSheetSnap>(initial);
  // KS-3190: ref на стартовую координату жеста и флаг «активный drag».
  // Через `useRef` — чтобы pointer-handlers не пересоздавались при
  // каждом рендере (важно для onPointerMove, который может стрелять
  // десятки раз в секунду; новые ссылки заставили бы React навешивать
  // listener'ы заново).
  const dragRef = useRef<{
    startY: number;
    startSnap: BottomSheetSnap;
    active: boolean;
  } | null>(null);

  const setSnap = useCallback((next: BottomSheetSnap) => {
    setSnapState(next);
  }, []);

  const cycleSnap = useCallback(() => {
    setSnapState((curr) => {
      const i = indexOf(curr);
      return SNAP_ORDER[(i + 1) % SNAP_ORDER.length];
    });
  }, []);

  const handleProps = useMemo<BottomSheetHandleProps>(
    () => ({
      onPointerDown: (e) => {
        // KS-3190: capture pointer чтобы продолжать получать move/up
        // даже когда палец уйдёт за пределы handle bar.
        try {
          (e.target as Element).setPointerCapture?.(e.pointerId);
        } catch {
          /* старые браузеры без pointer capture — ок, событие всё равно
             дойдёт до document'а */
        }
        dragRef.current = {
          startY: e.clientY,
          startSnap: snap,
          active: true,
        };
      },
      onPointerMove: (e) => {
        // На данном шаге не двигаем sheet «в реальном времени» — это
        // потребовало бы анимации height в стиле inline и пересчёта
        // CSS-var каждые 16мс. Базовая версия: реагируем только на
        // финальную точку (pointerup). Если когда-нибудь захочется
        // плавного drag — расширим без ломки контракта (snap
        // остаётся тот же; добавим `setDragOffset`).
        if (!dragRef.current?.active) return;
        // no-op (см. комментарий выше). Оставляем placeholder, чтобы
        // не нарушать pointer-capture цикл.
        void e;
      },
      onPointerUp: (e) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dy = drag.startY - e.clientY; // вверх — положительный
        dragRef.current = null;
        if (Math.abs(dy) < SWIPE_DELTA_PX) {
          // Tap (или почти-неподвижный pointer) — циклически следующий
          // snap. Это полезно на устройствах, где pointermove не
          // регистрируется (старые webview, эмуляторы), и даёт
          // запасной путь без drag'а.
          setSnapState((curr) => {
            const i = indexOf(curr);
            return SNAP_ORDER[(i + 1) % SNAP_ORDER.length];
          });
          return;
        }
        setSnapState(dy > 0 ? snapUp(drag.startSnap) : snapDown(drag.startSnap));
      },
      onPointerCancel: () => {
        dragRef.current = null;
      },
    }),
    [snap],
  );

  return { snap, setSnap, cycleSnap, handleProps };
}
