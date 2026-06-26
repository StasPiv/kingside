/**
 * KS-4277. Адаптер для `<OpeningTrainerPlayer>` — единственная точка
 * расхождения между гостевым демо-репертуаром (локальная валидация по
 * дереву + localStorage) и полноценной серверной сессией
 * (POST /sessions/:sid/move с discriminated union в ответе).
 *
 * Адаптер инкапсулирует ВЕСЬ источник данных и состояние (chess.js,
 * текущий FEN, прогресс, дерево). Плеер вызывает методы и применяет
 * результат к UI — у него нет знания о сервере, localStorage или
 * структуре `OpeningRepertoireDetailDto`.
 *
 * Внутреннее состояние адаптера НЕ должно меняться извне — после
 * каждого метода адаптер возвращает «снимок наружу» через
 * `OpeningTrainerInitialState` / `OpeningTrainerOutcome`. Плеер
 * хранит эти снимки в своём React-state.
 */

export interface OpeningTrainerCounters {
  score: number;
  correctMoves: number;
  wrongMoves: number;
  hintsUsed: number;
  /** Только серверная сессия — длина streak'а правильных ходов. */
  streak?: number;
  /** Только серверная сессия — для disable Undo на нулевом ходе. */
  movesPlayed?: number;
  /** Только серверная сессия — активен ли бонус-множитель. */
  bonusActive?: boolean;
}

export interface OpeningTrainerExpectedMove {
  moveUci: string;
  moveSan: string;
}

export interface OpeningTrainerBotMove {
  moveUci: string;
  moveSan: string;
  newFen: string;
}

export interface OpeningTrainerInitialState {
  /** Заголовок репертуара (для Demo header'а). */
  title?: string;
  /** Описание (для Demo header'а). */
  description?: string;
  side: 'white' | 'black';
  /** Стартовая позиция, на которой стоит доска. */
  currentFen: string;
  /** Подсветка последнего хода. */
  lastMoveUci: string | null;
  counters: OpeningTrainerCounters;
}

export interface SubmitMoveArgs {
  moveUci: string;
  /**
   * Время начала позиции (для серверного `responseTimeMs`). Для Demo
   * не используется — адаптер игнорирует.
   */
  positionShownAtMs: number;
}

export type OpeningTrainerOutcome =
  | {
      kind: 'correct';
      newFen: string;
      lastMoveUci: string | null;
      counters: OpeningTrainerCounters;
      /** Прибавка к score (только Server). У Local — 10 на правильный ход. */
      scoreDelta?: number;
      /** Ответный ход бота — Player применяет с задержкой `BOT_DELAY_MS`. */
      botMove?: OpeningTrainerBotMove | null;
    }
  | {
      kind: 'wrong';
      /** Куда вернуть доску после показа ошибочного хода. */
      newFen: string;
      /**
       * Задержка перед откатом. Для Demo = 600 (пользователь видит свой
       * ход, доска возвращается). Для Server = 0 (откат сразу, поверх
       * открывается wrong-modal).
       */
      resetDelayMs: number;
      expected: OpeningTrainerExpectedMove[];
      counters: OpeningTrainerCounters;
      /**
       * KS-4277: при `giveup` сервер сразу делает ответный ход бота
       * (показывает правильную линию). Player применяет его как
       * обычный bot-move перед откатом.
       */
      lastMoveUci?: string | null;
      botMove?: OpeningTrainerBotMove | null;
    }
  | {
      kind: 'line-complete';
      newFen: string;
      lastMoveUci: string | null;
      counters: OpeningTrainerCounters;
    }
  | {
      kind: 'line-restart';
      newFen: string;
      lastMoveUci: string | null;
      counters: OpeningTrainerCounters;
      botMove?: OpeningTrainerBotMove | null;
    }
  | {
      kind: 'tree-complete';
      newFen: string;
      lastMoveUci: string | null;
      counters: OpeningTrainerCounters;
      /** Куда уйти после показа финального фидбека. */
      resultRoute: string;
    };

export interface OpeningTrainerHintOutcome {
  moveUci: string;
  moveSan: string;
  counters: OpeningTrainerCounters;
}

/**
 * Какие управления и UX-блоки Плеер должен рендерить. Логика по типу
 * адаптера зашита здесь, чтобы Плеер не делал `instanceof`-проверок.
 */
export interface OpeningTrainerAdapterCapabilities {
  /** Модалка поверх доски при ошибочном ходе (Server only). */
  showWrongModal: boolean;
  /** Стрелка подсказки на доске (Server only). Local — текстом в фидбеке. */
  showHintArrow: boolean;
  /** Бейдж streak в счётчиках (Server only). */
  showStreak: boolean;
  /** Кнопка «Restart line» (Demo only). */
  showRestartLineButton: boolean;
  /** Кнопка «Reset progress» (Demo only). */
  showResetProgressButton: boolean;
  /** Кнопка «Undo» (Server only). */
  showUndoButton: boolean;
  /** Кнопка «Show answer» / giveup (Server only). */
  showGiveupButton: boolean;
  /** Кнопка «Finish session» (Server only). */
  showFinishButton: boolean;
}

/**
 * KS-4670. Результат принудительного перехода после `line-complete`-
 * outcome'а. Backend в обычном flow (KS-3277) выдаёт `line-restart`
 * или `tree-complete`, но в краевых случаях возвращает `line-complete`
 * (см. `OpeningTrainerMoveResult` в shared/types/opening-trainer.ts).
 * До KS-4670 фронт в этом случае зависал на финальной позиции —
 * пользователь не мог ни сходить, ни сдаться (`giveup` падает с
 * «Nothing to giveup»).
 *
 *   - `kind: 'next-line'` — backend подвинул сессию к следующей
 *     линии, фронт продолжает с новым `currentFen`.
 *   - `kind: 'finished'` — сессия закрыта, переходим на result.
 */
export type AdvanceAfterLineCompleteOutcome =
  | { kind: 'next-line'; state: OpeningTrainerInitialState }
  | { kind: 'finished'; resultRoute: string };

export interface OpeningTrainerAdapter {
  readonly capabilities: OpeningTrainerAdapterCapabilities;
  loadInitial(): Promise<OpeningTrainerInitialState>;
  submitMove(args: SubmitMoveArgs): Promise<OpeningTrainerOutcome>;
  requestHint(): Promise<OpeningTrainerHintOutcome>;
  restartLine?(): Promise<OpeningTrainerInitialState>;
  resetProgress?(): Promise<OpeningTrainerInitialState>;
  undoLastMove?(): Promise<OpeningTrainerInitialState>;
  giveup?(): Promise<OpeningTrainerOutcome>;
  finishSession?(): Promise<{ resultRoute: string }>;
  /**
   * KS-4670. Backend выдал `line-complete` — линия закончилась, но
   * сессия ещё не закрыта. Фронт зовёт этот метод чтобы получить
   * либо новую стартовую позицию следующей линии, либо сигнал
   * «сессия завершена, идём на result». Опционален: Demo-адаптер
   * не реализует.
   */
  advanceAfterLineComplete?(): Promise<AdvanceAfterLineCompleteOutcome>;
}
