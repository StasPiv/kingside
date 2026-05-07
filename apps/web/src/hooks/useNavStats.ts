import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { FeatureFlags } from '@kingside/shared';

import { api } from '../api';
import { ApiError } from '../ApiError';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';

/**
 * KS-2373 (mobile-bottom-bar динамические top-3 разделы).
 *
 * Backend контракт (KS-2373 backend, коммит b72b1176):
 *   - POST /user/nav-stats/increment {route: string} → 204 (JWT,
 *     5с cooldown на стороне сервера).
 *   - GET  /user/nav-stats/top?limit=3 → {items: [{route, count}]}
 *     (JWT, max limit=20).
 *   - whitelist routes: play, tournaments, workshop, lessons, drills,
 *     broadcasts, archive, profile, puzzles.
 *
 * Здесь живёт:
 *   - `NAV_ROUTES` — единый whitelist + маппинг pathname → route +
 *     URL для перехода + i18n-ключи + emoji-иконки.
 *   - `resolveNavRoute(pathname)` — определяет, к какому из 9 routes
 *     относится текущий URL (или null).
 *   - `useTrackNavStats()` — слушатель `useLocation`, дебаунсит
 *     POST-инкремент (~3.5с после стабилизации pathname). Подключается
 *     ОДИН раз на всё приложение (в App.tsx).
 *   - `useTopNavStats(limit)` — GET top, фильтрует по feature-flags.
 *     Возвращает массив `NavRoute[]` без счётчиков (порядок —
 *     порядок ответа сервера, уже отсортированный desc).
 */

export type NavRoute =
  | 'play'
  | 'tournaments'
  | 'workshop'
  | 'lessons'
  | 'drills'
  | 'broadcasts'
  | 'archive'
  | 'profile'
  | 'puzzles'
  | 'precision';

export interface NavRouteMeta {
  /** path, на который ведёт ссылка из bar'а. */
  to: string;
  /** Префиксы URL, по которым считаем кнопку активной. */
  matches: string[];
  /** Emoji-иконка (как в текущем MobileBottomBar). */
  icon: string;
  /** i18n-ключ названия. */
  labelKey: string;
  /** Fallback-текст, если ключ не найден. */
  labelFallback: string;
  /**
   * KS-2544: i18n-ключ короткого названия (для mobile bottom bar,
   * где места меньше). Опционально — если не задан, mobile bar
   * использует обычный `labelKey`.
   */
  labelShortKey?: string;
  /** KS-2544: fallback короткого названия. */
  labelShortFallback?: string;
  /** Какой feature-flag должен быть `true`. `null` = всегда видим. */
  flag: keyof FeatureFlags | null;
}

export const NAV_ROUTES: Record<NavRoute, NavRouteMeta> = {
  play: {
    to: '/play',
    matches: ['/play'],
    icon: '♟',
    labelKey: 'nav.play',
    labelFallback: 'Play',
    flag: null,
  },
  tournaments: {
    to: '/tournaments',
    matches: ['/tournaments', '/arena', '/t/'],
    icon: '🏆',
    labelKey: 'nav.tournaments',
    labelFallback: 'Tournaments',
    flag: 'tournamentsEnabled',
  },
  workshop: {
    to: '/workshop',
    matches: ['/workshop', '/analysis'],
    icon: '🔬',
    labelKey: 'nav.workshop',
    labelFallback: 'Workshop',
    flag: null,
  },
  lessons: {
    to: '/lessons',
    matches: ['/lessons'],
    /* KS-2550: 📚 → 🎓 (академическая шляпа), 📚 переехала в archive. */
    icon: '🎓',
    labelKey: 'nav.lessons',
    labelFallback: 'Lessons',
    flag: 'lessonsEnabled',
  },
  drills: {
    to: '/drills',
    matches: ['/drills'],
    /* KS-2550: 🎯 → 🧠 (тренажёр-«накачка мозга»). 🎯 переехала в precision. */
    icon: '🧠',
    labelKey: 'nav.drills',
    labelFallback: 'Drills',
    flag: 'drillsEnabled',
  },
  broadcasts: {
    to: '/broadcasts',
    matches: ['/broadcasts'],
    icon: '📺',
    labelKey: 'nav.tv',
    labelFallback: 'TV',
    flag: 'broadcastsEnabled',
  },
  archive: {
    to: '/archive',
    matches: ['/archive'],
    /* KS-2550: 🗂 → 📚 (книги/собрание партий — лучше передаёт «архив»). */
    icon: '📚',
    labelKey: 'archive:menuTitle',
    labelFallback: 'Archive',
    flag: null,
  },
  profile: {
    to: '/profile',
    matches: ['/profile', '/player/'],
    icon: '👤',
    labelKey: 'nav.profile',
    labelFallback: 'Profile',
    flag: null,
  },
  puzzles: {
    to: '/daily',
    matches: ['/daily', '/puzzles', '/puzzle-rush', '/puzzle'],
    icon: '🧩',
    labelKey: 'nav.puzzles',
    labelFallback: 'Puzzles',
    flag: 'puzzlesEnabled',
  },
  // KS-2540 / ADR-048: «Тренировка точности» — bottom-bar учёт
  // переходов на /precision. Backend whitelist расширен в KS-2537,
  // POST /user/nav-stats/increment {route:'precision'} → 204. Префикс
  // /precision не пересекается с другими ключами выше (resolveNavRoute
  // последовательно проверяет matches; /precision !== /puzzle*, /play*).
  precision: {
    to: '/precision',
    matches: ['/precision'],
    /* KS-2550: 🎓 → 🎯 (мишень — точность/прицел). 🎓 переехала в lessons. */
    icon: '🎯',
    labelKey: 'nav.precision',
    labelFallback: 'Precision training',
    // KS-2544: для mobile bottom bar используем короткое «Precision».
    labelShortKey: 'nav.precisionShort',
    labelShortFallback: 'Precision',
    flag: 'puzzlesEnabled',
  },
};

/**
 * Сопоставить pathname одному из whitelist-routes (или вернуть null,
 * если URL вне навигации — например, /settings, /game/:id). Префиксное
 * совпадение, более специфичные ключи (/puzzle-rush) проверяются
 * ДО более общих благодаря порядку в matches.
 */
export function resolveNavRoute(pathname: string): NavRoute | null {
  for (const key of Object.keys(NAV_ROUTES) as NavRoute[]) {
    const meta = NAV_ROUTES[key];
    if (
      meta.matches.some((p) =>
        // Если паттерн заканчивается на '/', значит это «префикс» —
        // достаточно startsWith. Иначе требуем либо полного совпадения,
        // либо префикса с разделителем (`/play/foo`, не `/playoff`).
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
 * Подключается один раз в App. На каждое изменение `pathname` ставит
 * таймер на TRACK_DEBOUNCE_MS, при срабатывании — POST с маппингом
 * pathname → route. Если pathname вне whitelist — таймер просто
 * отменяется. Без auth — silent skip (backend всё равно вернёт 401,
 * избегаем лишних запросов).
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
      // Молча игнорируем любые ошибки — это не критичная фича,
      // и backend сам имеет 5с cooldown (POST в течение 5с от того же
      // пользователя возвращает 204 без записи). Никаких toast'ов.
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
 * GET /user/nav-stats/top?limit=N. Фильтрует ответ:
 *   - оставляет только routes, которые есть в `NAV_ROUTES` (на случай
 *     если backend отдал что-то новое или whitelist разъехался);
 *   - дополнительно фильтрует по feature-flags (если у пользователя
 *     `puzzlesEnabled=false`, /puzzles в bar'е не показываем, даже
 *     если он там в топе).
 *
 * Возвращает stable ссылку (без счётчиков, только порядок).
 * При unauth / ошибке / loading — пустой массив.
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
        // Backend ограничивает до 20, нам нужно не больше 9 (всего routes
        // в whitelist), отправляем как есть. Хотим limit=top-3 + запас
        // на отфильтрованные feature-flag'ом — берём втрое.
        `/user/nav-stats/top?limit=${Math.max(limit * 3, limit)}`,
      );
      const filtered: NavRoute[] = [];
      for (const item of resp.items) {
        if (!(item.route in NAV_ROUTES)) continue;
        const r = item.route as NavRoute;
        const meta = NAV_ROUTES[r];
        if (meta.flag !== null && !flags[meta.flag]) continue;
        filtered.push(r);
        if (filtered.length >= limit) break;
      }
      setRoutes(filtered);
    } catch (e) {
      // 401 (unauth) — пустой массив, пусть UI покажет дефолт.
      // Любая другая ошибка — тоже silent, фоллбек на дефолт.
      if (!(e instanceof ApiError) || e.status !== 401) {
        // только для diagnose в dev — без логирования в prod-консоль.
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
