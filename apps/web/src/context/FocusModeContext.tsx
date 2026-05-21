import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { BottomSheetSnap } from '../hooks/useBottomSheet';

/**
 * KS-3188 (ADR-073 §7 F1) — глобальный контекст «фокус-режима» layout'а.
 *
 * Шаг урока типа `'game'` на мобильном съедает почти весь viewport
 * доской + tree/explorer/SF под ней. Декорации MainLayout (header
 * со всеми кнопками + MobileBottomBar) на этом фоне отъедают полезное
 * место и ломают восприятие urok'а как самостоятельной задачи. Этот
 * контекст разрешает компонентам страницы заявить «нам нужен максимум
 * экрана» — MainLayout слушает значение и переключается в compact-
 * вариант шапки (см. CSS `.app.focus-mode-active`) + скрывает
 * MobileBottomBar.
 *
 * Контракт намеренно минимален — `{ active, enable, disable }`. Эффект
 * визуально применяется только на mobile (через `@media` в CSS); на
 * desktop `active=true` не меняет layout. Это даёт безопасную семантику
 * «активировать всегда» в `useEffect` — без media-query в JS, jsdom-
 * тесты не страдают от `matchMedia` mock'ов.
 *
 * Provider оборачивает `<MainLayout>` в `App`. Несколько одновременных
 * активаций (например два вложенных компонента) — пока не поддерживаем:
 * счётчик ссылок добавим только если появится реальный кейс. Сейчас
 * считаем последнее `enable()` истиной, `disable()` — выключает.
 */

interface FocusModeContextValue {
  active: boolean;
  enable: () => void;
  disable: () => void;
  /**
   * KS-3190 (ADR-073 §7 F3): текущая snap-точка bottom-sheet'а внутри
   * focus-mode. Хранится в контексте, чтобы `AnalysisSidebar` (где
   * физически живёт sheet) и `GameStep` / `UserLessonView` (где
   * подстраивается высота доски и layout) видели одно и то же
   * значение без prop-drilling'а через 3-4 компонента.
   */
  sheetSnap: BottomSheetSnap;
  setSheetSnap: (next: BottomSheetSnap) => void;
}

const FocusModeContext = createContext<FocusModeContextValue | null>(null);

interface FocusModeProviderProps {
  children: ReactNode;
}

export function FocusModeProvider({ children }: FocusModeProviderProps) {
  const [active, setActive] = useState(false);
  const [sheetSnap, setSheetSnap] = useState<BottomSheetSnap>('peek');
  const enable = useCallback(() => setActive(true), []);
  const disable = useCallback(() => {
    setActive(false);
    // KS-3190: при выходе из focus-mode сбрасываем snap к дефолту,
    // чтобы повторное включение начало с peek (а не с last-used full).
    setSheetSnap('peek');
  }, []);
  const value = useMemo<FocusModeContextValue>(
    () => ({ active, enable, disable, sheetSnap, setSheetSnap }),
    [active, enable, disable, sheetSnap],
  );
  return (
    <FocusModeContext.Provider value={value}>
      {children}
    </FocusModeContext.Provider>
  );
}

/**
 * Если хук вызывается вне `FocusModeProvider`, возвращаем
 * безопасный no-op фолбэк (`active=false`, пустые `enable`/`disable`).
 * Это позволяет компонентам не падать в тестах, где их монтируют
 * изолированно без обёртки. В реальном приложении Provider всегда
 * на месте — компонент бы упал в dev-моде, что нежелательно.
 */
const NOOP_CONTEXT: FocusModeContextValue = {
  active: false,
  enable: () => undefined,
  disable: () => undefined,
  sheetSnap: 'peek',
  setSheetSnap: () => undefined,
};

export function useFocusMode(): FocusModeContextValue {
  return useContext(FocusModeContext) ?? NOOP_CONTEXT;
}
