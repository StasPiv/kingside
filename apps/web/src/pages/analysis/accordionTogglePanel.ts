/**
 * KS-3696 (исправлено по уточнению пользователя). Правило правой
 * колонки: взаимно исключаются ТОЛЬКО панели «Движок» (`engine`) и
 * «AI» (`ai`) — пользователь не должен видеть одновременно анализ
 * движком и оценку AI, потому что Stockfish при этом молотит и
 * путает восприятие. Остальные панели — «Нотация» (`moves`) и
 * «Книга» (`book`) — открываются и закрываются независимо и могут
 * сосуществовать с любой из engine/ai и друг с другом.
 *
 * Итог: в один момент могут быть открыты до трёх панелей одновременно
 * (engine ИЛИ ai) + moves + book.
 *
 * `gameInfo` (плашка-заголовок) переключается независимо.
 *
 * Дополнительно возвращает `engineWillCollapse: boolean` — каллер
 * (AnalysisPage) использует это, чтобы поставить Stockfish на паузу,
 * когда engine-блок закрывается (мешает молотить впустую под скрытым
 * блоком).
 */
export interface PanelStates {
  gameInfo: boolean;
  engine: boolean;
  moves: boolean;
  ai: boolean;
  book: boolean;
  /**
   * KS-4024 / ADR-122. Пятый ключ — панель «Метрики» (позиционные
   * метрики партии). Открывается/закрывается независимо от других
   * (как `moves`/`book`), Stockfish не задействует — никаких
   * взаимных правил с `engine`/`ai`.
   */
  metrics: boolean;
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
  const willBeOpen = !wasOpen;
  const next: PanelStates = { ...prev, [panel]: willBeOpen };
  let engineWillCollapse = false;

  if (panel === 'engine') {
    if (wasOpen) {
      // engine закрывается по клику — пользователь сам убирает анализ.
      engineWillCollapse = true;
    } else if (prev.ai) {
      // engine открывается — закрываем ai (они взаимно исключаются).
      next.ai = false;
    }
  } else if (panel === 'ai') {
    if (willBeOpen && prev.engine) {
      // ai открывается — закрываем engine и ставим Stockfish на паузу.
      next.engine = false;
      engineWillCollapse = true;
    }
    // ai сам по себе закрывается — engine не трогаем.
  }
  // moves / book — независимые, ничего больше не меняют.

  return { next, engineWillCollapse };
}
