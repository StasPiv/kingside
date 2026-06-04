/**
 * KS-3696. Чистая редюсер-функция для accordion-поведения правой
 * колонки `AnalysisPage`. Открытие одной панели схлопывает остальные
 * три; повторный клик по уже открытой — закрывает её. `gameInfo`
 * не входит в accordion, его флаг переключается независимо.
 *
 * Дополнительно возвращает `engineWillCollapse: boolean` — каллер
 * (AnalysisPage) использует это, чтобы поставить Stockfish на паузу,
 * когда engine-блок закрывается (мешает молотить впустую под скрытым
 * блоком, см. acceptance KS-3696).
 */
export interface PanelStates {
  gameInfo: boolean;
  engine: boolean;
  moves: boolean;
  ai: boolean;
  book: boolean;
}

export type PanelKey = keyof PanelStates;

export interface PanelTransition {
  next: PanelStates;
  engineWillCollapse: boolean;
}

export function panelToggleReducer(
  prev: PanelStates,
  panel: PanelKey,
): PanelTransition {
  if (panel === 'gameInfo') {
    return {
      next: { ...prev, gameInfo: !prev.gameInfo },
      engineWillCollapse: false,
    };
  }
  const wasOpen = prev[panel];
  const engineWillCollapse =
    (panel === 'engine' && wasOpen) ||
    (panel !== 'engine' && prev.engine);
  const next: PanelStates = {
    gameInfo: prev.gameInfo,
    engine: panel === 'engine' ? !wasOpen : false,
    moves: panel === 'moves' ? !wasOpen : false,
    ai: panel === 'ai' ? !wasOpen : false,
    book: panel === 'book' ? !wasOpen : false,
  };
  return { next, engineWillCollapse };
}
