import type { NavigateFunction } from 'react-router-dom';
import { api } from '../api';

/**
 * KS-2403 follow-up: единая точка перехода в `/analysis/<id>` из мест,
 * где у пользователя есть готовый PGN партии (архив, трансляции,
 * мастерская PGN-файлов).
 *
 * # Зачем helper
 *
 * Раньше каждое такое место делало `navigate('/analysis', { state })`
 * без id. `AnalysisPage` сам создавал запись на mount и подменял URL
 * через `window.history.replaceState('/analysis/<id>')`. React Router
 * об этой подмене не знал, второй клик из той же сессии приходил на
 * тот же `/analysis` (для роутера), компонент не пересоздавался,
 * `localIdRef.current` оставался равен первому id, и внутренний autosave
 * перезаписывал PGN первой партии телом второй. Симптом — «одна и та
 * же партия везде» (двух разных id с одинаковыми ходами, headers
 * рассинхронизированы с moves).
 *
 * Решение: создаём analysis-запись через `POST /analyses` ДО navigate,
 * сразу идём на `/analysis/<id>`. URL содержит уникальный id, обёртка
 * `<AnalysisPageInner key={id} />` (KS-2403) пересоздаёт компонент при
 * каждом клике, autosave пишет в правильную запись.
 *
 * Если POST /analyses падает (offline/auth) — fallback на старый путь
 * `navigate('/analysis', state)`, чтобы переход не блокировался.
 */
export async function openAnalysisFromPgn(
  navigate: NavigateFunction,
  args: {
    pgn: string;
    title: string;
    /** Доп. поля state навигации (breadcrumb*, прочее). */
    state?: Record<string, unknown>;
    /** Переход через `replace`, а не push (например, для редиректа из
     *  legacy URL `/broadcasts/<t>/<r>/<g>` на `/analysis/<id>`). */
    replace?: boolean;
  },
): Promise<void> {
  const navState = { pgn: args.pgn, title: args.title, ...(args.state ?? {}) };
  const navOpts: { state: Record<string, unknown>; replace?: true } = {
    state: navState,
  };
  if (args.replace) navOpts.replace = true;
  try {
    const created = await api.post<{ id: string }>('/analyses', {
      pgn: args.pgn,
      title: args.title,
      category: 'analysis',
    });
    navigate(`/analysis/${created.id}`, navOpts);
  } catch {
    navigate('/analysis', navOpts);
  }
}
