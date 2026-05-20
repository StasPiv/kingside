import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { FeatureFlags } from '@kingside/shared';

import { configApi } from '../api/configApi';

/**
 * KS-2105 — runtime feature-flags на фронте.
 *
 * До этого тикета флаги читались из `import.meta.env.VITE_FEATURE_*`
 * (build-time): чтобы переключить, требовался rebuild + redeploy.
 * Теперь источник истины — backend (`GET /config`, см. KS-2104).
 *
 * # Логика провайдера
 *
 * 1. На mount грузим `/config` и кладём `featureFlags` в state.
 * 2. Параллельно при первом рендере используем cached-значения из
 *    `localStorage` (если есть): после reload пользователь сразу
 *    видит ту же раскладку, без мигания «есть → нет → есть».
 * 3. Если cache пуст — стартуем с DEFAULT_FLAGS (это совпадает с
 *    серверным whitelist, KS-2104). Это даёт стабильный first-paint
 *    даже на холодном devbox без `/config` ответа.
 * 4. После успешного ответа — обновляем state + сохраняем в cache.
 * 5. Раз в 5 минут перепроверяем (на случай, если админ переключил
 *    флаг в долгоживущей вкладке).
 *
 * # Дефолты
 *
 * Если backend недоступен совсем (network/5xx) и cache пуст —
 * остаёмся на `DEFAULT_FLAGS`. Сейчас по KS-2104 дефолт
 * `lessonsEnabled = true` — раздел «Уроки» виден по умолчанию,
 * аварийный rollback это уже изменение через PATCH (требует
 * online-PATCH, поэтому отключённый бэк всё равно не помог бы).
 */

const STORAGE_KEY = 'featureFlags:v1';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 мин

/**
 * Дефолты повторяют серверный whitelist (KS-2104). При расширении
 * `FeatureFlags` добавлять и сюда — иначе компилятор не пропустит
 * (`Record<keyof FeatureFlags, boolean>`).
 *
 * KS-2218: дефолты по новым флагам (KS-2217) совпадают с серверным
 * whitelist:
 *  - `puzzlesEnabled` = false (раздел «Задачи» временно скрыт);
 *  - `broadcastsEnabled` = true;
 *  - `tournamentsEnabled` = true.
 *
 * KS-2228 (KS-2222): чат-ассистент `assistantEnabled` = false
 * (иконка `ChatWidget` скрыта по умолчанию). Включается админом
 * через PATCH /admin/feature-flags/assistantEnabled.
 */
export const DEFAULT_FLAGS: FeatureFlags = {
  lessonsEnabled: true,
  puzzlesEnabled: false,
  broadcastsEnabled: true,
  tournamentsEnabled: true,
  assistantEnabled: false,
  // KS-2231 / KS-2232 (ADR-035 §7.2, Drills E2): раздел «Тренажёры»
  // включается админом. Default false совпадает с серверным whitelist.
  // KS-2331: ключ обязан быть здесь — иначе loadFromCache итерирует
  // только ключи DEFAULT_FLAGS и теряет drillsEnabled из localStorage,
  // а первый рендер падает на дефолте → редирект /drills→/lobby.
  drillsEnabled: false,
  // ADR-067 (KS-3130/F1): UI «Студии» удалён, но ключ остаётся в
  // shared `FeatureFlags` (TypeScript-контракт) до закрытия S1
  // (KS-3132). Дефолт принудительно `false` — раздела больше нет;
  // строка уйдёт одним коммитом после S1 (поле исчезнет из типа).
  studiesEnabled: false,
};

interface FeatureFlagsContextValue {
  flags: FeatureFlags;
  /** True пока первый запрос ещё не вернулся (даже если cache есть). */
  loading: boolean;
  /** Текст последней ошибки запроса. null если успешно или ещё не пробовали. */
  error: string | null;
  /** Принудительный рефетч (для админ-сценариев / тестов). */
  refresh: () => Promise<void>;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

function loadFromCache(): FeatureFlags | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      // Аккуратно мержим: если на бэке появились новые ключи, а в
      // cache их нет — возьмём дефолт. Если в cache есть «лишние»
      // ключи (например, от старой версии фронта) — игнорируем.
      const merged: FeatureFlags = { ...DEFAULT_FLAGS };
      for (const k of Object.keys(DEFAULT_FLAGS) as (keyof FeatureFlags)[]) {
        if (typeof parsed[k] === 'boolean') {
          merged[k] = parsed[k];
        }
      }
      return merged;
    }
  } catch {
    // localStorage недоступен или повреждён — игнорируем.
  }
  return null;
}

function saveToCache(flags: FeatureFlags): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch {
    // ignore
  }
}

interface FeatureFlagsProviderProps {
  children: ReactNode;
  /** Для тестов: подменить начальные флаги, чтобы не лезть в localStorage. */
  initialFlags?: FeatureFlags;
  /** Для тестов: отключить периодический рефетч. */
  disableRefresh?: boolean;
}

export function FeatureFlagsProvider({
  children,
  initialFlags,
  disableRefresh,
}: FeatureFlagsProviderProps) {
  // Стартовое значение: cache → initialFlags-override → DEFAULT_FLAGS.
  const [flags, setFlags] = useState<FeatureFlags>(
    () => initialFlags ?? loadFromCache() ?? DEFAULT_FLAGS,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Чтобы не зависеть от закрытий внутри setInterval.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchFlags = useCallback(async () => {
    try {
      const res = await configApi.getConfig();
      if (!mountedRef.current) return;
      setFlags(res.featureFlags);
      saveToCache(res.featureFlags);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      const message = e instanceof Error ? e.message : 'Failed to load config';
      setError(message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFlags();
    if (disableRefresh) return;
    const id = setInterval(() => {
      void fetchFlags();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchFlags, disableRefresh]);

  const value = useMemo<FeatureFlagsContextValue>(
    () => ({ flags, loading, error, refresh: fetchFlags }),
    [flags, loading, error, fetchFlags],
  );

  return (
    <FeatureFlagsContext.Provider value={value}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

/**
 * Низкоуровневый доступ — нужен, например, в админских экранах,
 * где надо отрендерить состояние загрузки/ошибки. Большинству
 * компонент достаточно `useFeatureFlag('key')`.
 */
export function useFeatureFlags(): FeatureFlagsContextValue {
  const ctx = useContext(FeatureFlagsContext);
  if (!ctx) {
    // Безопасный fallback: за пределами провайдера возвращаем
    // дефолты, чтобы случайный рендер вне App-дерева не падал
    // (например, сторонний lib-тест без обёртки). Потребитель видит
    // дефолтное поведение — это лучше, чем runtime-исключение.
    return {
      flags: DEFAULT_FLAGS,
      loading: false,
      error: null,
      refresh: async () => {
        /* noop вне Provider */
      },
    };
  }
  return ctx;
}

export function useFeatureFlag(key: keyof FeatureFlags): boolean {
  const { flags } = useFeatureFlags();
  return flags[key];
}
