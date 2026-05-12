import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { FeatureFlags } from '@kingside/shared';

import { api } from '../api';
import { ApiError } from '../ApiError';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';

/**
 * KS-2373 → KS-2805 (ADR-058 §5.1, §6.3 T8).
 *
 * Backend контракт после KS-2809:
 *   - POST /user/nav-stats/increment {route}: принимает и legacy-ключи
 *     (puzzles, drills, precision, puzzle-rush, workshop, archive,
 *     tournaments, lessons), и групповые (play, train, learn, analyze,
 *     broadcasts, profile). Старые клиенты продолжают работать.
 *   - GET /user/nav-stats/top: backend агрегирует legacy → group:
 *       puzzles+drills+precision+puzzle-rush+train → 'train'
 *       workshop+archive+analyze                  → 'analyze'
 *       tournaments+play                          → 'play'
 *       lessons+learn                             → 'learn'
 *     Фронт ожидает только групповые ключи в /top.
 *
 * KS-2805: фронт-whitelist сужен до 6 групп:
 *   `play` / `train` / `learn` / `analyze` / `broadcasts` / `profile`.
 * `resolveNavRoute(pathname)` маппит вложенные маршруты на группы и
 * `useTrackNavStats` шлёт инкремент уже групповым ключом (не legacy).
 * `useTopNavStats` дополнительно отфильтрует возможный legacy в ответе
 * (защита от рассинхронизации с серверной агрегацией).
 */

export type NavRoute =
  | 'play'
  | 'train'
  | 'learn'
  | 'analyze'
  | 'broadcasts'
  | 'profile';

export interface NavRouteMeta {
  /** path, на который ведёт ссылка из bar'а / drawer'а. */
  to: string;
  /** Префиксы URL, по которым считаем кнопку активной. */
  matches: string[];
  /** Emoji-иконка. */
  icon: string;
  /** i18n-ключ названия. */
  labelKey: string;
  /** Fallback-текст, если ключ не найден. */
  labelFallback: string;
  /**
   * KS-2544: i18n-ключ короткого названия (для mobile bottom bar,
   * где места меньше). Опционально.
   */
  labelShortKey?: string;
  labelShortFallback?: string;
  /**
   * KS-2805: gate группы. Если задан `flag` — группа видна когда
   * `flags[flag] === true`. Для составных условий (train виден если
   * хотя бы один из puzzles/drills включён) используем `customGate`.
   * `flag === null` и нет `customGate` → группа видна всегда.
   */
  flag: keyof FeatureFlags | null;
  /**
   * KS-2805: кастомное условие видимости — имеет приоритет над `flag`.
   * Возвращает `true` если группа должна быть видна для данного набора
   * флагов. Используется для группы `train`: видна если puzzlesEnabled
   * ИЛИ drillsEnabled ИЛИ всегда (Puzzle Rush открыт без флага).
   */
  customGate?: (flags: FeatureFlags) => boolean;
}

/**
 * KS-2805: 6 групп. Порядок в объекте — порядок проверки в
 * `resolveNavRoute`. Более специфичные `matches` ставим раньше,
 * чтобы `/puzzle-rush` не перепутался с `/puzzles` (оба идут в train,
 * но если бы они мапились в разные группы — порядок имел бы значение).
 */
export const NAV_ROUTES: Record<NavRoute, NavRouteMeta> = {
  play: {
    to: '/play',
    matches: ['/play', '/tournaments'],
    icon: '♟',
    labelKey: 'nav.play',
    labelFallback: 'Play',
    flag: null,
  },
  train: {
    to: '/train',
    matches: ['/train', '/puzzle-rush', '/puzzles', '/puzzle', '/drills', '/precision'],
    icon: '🧠',
    labelKey: 'nav.train',
    labelFallback: 'Train',
    // Rush всегда открыт → группа видна, даже если puzzlesEnabled и
    // drillsEnabled оба false. Хук на будущий gating Rush'а — заменим
    // на `flags.puzzlesEnabled || flags.drillsEnabled` когда Rush
    // получит свой флаг.
    flag: null,
    customGate: (flags) =>
      flags.puzzlesEnabled || flags.drillsEnabled || true,
  },
  learn: {
    to: '/lessons',
    matches: ['/lessons'],
    icon: '🎓',
    labelKey: 'nav.lessons',
    labelFallback: 'Lessons',
    flag: 'lessonsEnabled',
  },
  analyze: {
    to: '/analyze',
    matches: ['/analyze', '/workshop', '/analysis', '/archive'],
    icon: '🔬',
    labelKey: 'nav.analyze',
    labelFallback: 'Analyze',
    flag: null,
  },
  broadcasts: {
    to: '/broadcasts',
    matches: ['/broadcasts'],
    icon: '📺',
    labelKey: 'nav.tv',
    labelFallback: 'TV',
    flag: 'broadcastsEnabled',
  },
  profile: {
    to: '/profile',
    matches: ['/profile', '/player/'],
    icon: '👤',
    labelKey: 'nav.profile',
    labelFallback: 'Profile',
    flag: null,
  },
};

/**
 * KS-2805: список legacy-ключей, которые backend KS-2809 знает на
 * `/increment`, но в `/top` агрегирует на группы. Используем для
 * filter'а в `useTopNavStats` — если ответ всё же пришёл с legacy,
 * мапим на группу или отбрасываем.
 */
const LEGACY_TO_GROUP: Record<string, NavRoute> = {
  puzzles: 'train',
  drills: 'train',
  precision: 'train',
  'puzzle-rush': 'train',
  workshop: 'analyze',
  archive: 'analyze',
  tournaments: 'play',
  lessons: 'learn',
};

/**
 * KS-2805: дефолтный набор top-3 групп для UI до первого ответа backend
 * (или для гостя — авторизация даёт top-3 из API). По ADR-058 §5.1.
 */
export const DEFAULT_TOP: NavRoute[] = ['play', 'train', 'learn'];

/**
 * KS-2805: сопоставить pathname одной из 6 групп.
 * Возвращает `null` для маршрутов вне навигационного whitelist'а
 * (например `/settings`, `/game/:id`, `/lobby`, `/feedback`).
 *
 * Префикс-матчинг строгий: либо полное совпадение, либо начало с
 * `<prefix>/` (как в Sidebar после KS-2790). Если паттерн заканчивается
 * на `/` (например `'/player/'`) — startsWith.
 */
export function resolveNavRoute(pathname: string): NavRoute | null {
  for (const key of Object.keys(NAV_ROUTES) as NavRoute[]) {
    const meta = NAV_ROUTES[key];
    if (
      meta.matches.some((p) =>
        p.endsWith('/')
          ? pathname.startsWith(p)
          : pathname === p || pathname.startsWith(p + '/'),
      )
    ) {
      return key;
    }
  }
  return null;
}

/** Дебаунс: pathname должен «стоять» N мс перед инкрементом. */
const TRACK_DEBOUNCE_MS = 3500;

/**
 * Подключается один раз в App.tsx. На каждое изменение `pathname`
 * ставит таймер; при срабатывании — POST с групповым ключом
 * (`resolveNavRoute(pathname)`). Если pathname вне whitelist —
 * таймер отменяется. Без auth — silent skip.
 */
export function useTrackNavStats(): void {
  const location = useLocation();
  const { user } = useAuth();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!user) return;
    const route = resolveNavRoute(location.pathname);
    if (!route) return;
    timerRef.current = setTimeout(() => {
      void api
        .post('/user/nav-stats/increment', { route })
        .catch(() => undefined);
      timerRef.current = null;
    }, TRACK_DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [location.pathname, user]);
}

interface NavStatsTopResponse {
  items: { route: string; count: number }[];
}

/**
 * KS-2805: GET /user/nav-stats/top. Backend KS-2809 уже агрегирует
 * legacy → group, но защитно делаем второй маппинг на фронте: если
 * пришёл legacy-ключ (`puzzles`, `drills`, ...) — превращаем в группу;
 * если ключ не из 6 групп И не из legacy — отбрасываем.
 *
 * После маппинга дедуплицируем (одна группа может встретиться дважды,
 * если в одном ответе есть и legacy, и группа) и применяем
 * feature-flag/customGate-gating.
 *
 * Без auth → пустой массив (UI покажет DEFAULT_TOP сам).
 */
export function useTopNavStats(limit = 3): {
  routes: NavRoute[];
  loading: boolean;
} {
  const { user } = useAuth();
  const { flags } = useFeatureFlags();
  const [routes, setRoutes] = useState<NavRoute[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const fetchTop = useCallback(async () => {
    if (!user) {
      setRoutes([]);
      return;
    }
    setLoading(true);
    try {
      const resp = await api.get<NavStatsTopResponse>(
        // Берём с запасом — после агрегации/маппинга и gating'а
        // нужно отдать `limit` (по умолчанию 3) групп.
        `/user/nav-stats/top?limit=${Math.max(limit * 3, limit)}`,
      );
      const seen = new Set<NavRoute>();
      const filtered: NavRoute[] = [];
      for (const item of resp.items) {
        // 1. Маппим legacy → group если backend агрегацию пропустил.
        const groupKey: NavRoute | undefined =
          item.route in NAV_ROUTES
            ? (item.route as NavRoute)
            : LEGACY_TO_GROUP[item.route];
        if (!groupKey) continue;
        if (seen.has(groupKey)) continue;
        // 2. Gating по feature-flags / customGate.
        const meta = NAV_ROUTES[groupKey];
        if (meta.customGate) {
          if (!meta.customGate(flags)) continue;
        } else if (meta.flag !== null && !flags[meta.flag]) {
          continue;
        }
        seen.add(groupKey);
        filtered.push(groupKey);
        if (filtered.length >= limit) break;
      }
      setRoutes(filtered);
    } catch (e) {
      // 401 — silent (гость / истёкший токен). Прочие — тоже silent
      // (не критичная фича, fallback на DEFAULT_TOP).
      if (!(e instanceof ApiError) || e.status !== 401) {
        // dev-only diagnose hook — без console.* в prod.
      }
      setRoutes([]);
    } finally {
      setLoading(false);
    }
  }, [user, limit, flags]);

  useEffect(() => {
    void fetchTop();
  }, [fetchTop]);

  return { routes, loading };
}
