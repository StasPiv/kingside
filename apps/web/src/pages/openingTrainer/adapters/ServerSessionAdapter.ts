/**
 * KS-4277. Серверный адаптер для аутентифицированной сессии opening
 * trainer (KS-3273+).
 *
 * Каждый метод — один HTTP-вызов; ответы маппятся в общий
 * `OpeningTrainerOutcome`, чтобы `<OpeningTrainerPlayer>` обработал их
 * единообразно. Streak вычисляется тут же (на M1 backend не возвращает
 * counter явно — аппроксимируем по дельтам correct/wrong).
 *
 * До KS-4277 эта же логика была размазана внутри
 * `OpeningTrainerSessionPage.tsx` (708 строк UI + state + API).
 */
import { openingTrainerApi } from '../../../api/openingTrainerApi';
import {
  isCorrectMove,
  isLineCompleteMove,
  isLineRestartMove,
  isTreeCompleteMove,
  isWrongMove,
} from '@kingside/shared';
import type {
  OpeningTrainerSessionDto,
} from '@kingside/shared';
import type {
  OpeningTrainerAdapter,
  OpeningTrainerAdapterCapabilities,
  OpeningTrainerCounters,
  OpeningTrainerHintOutcome,
  OpeningTrainerInitialState,
  OpeningTrainerOutcome,
  SubmitMoveArgs,
} from './types';

export interface ServerSessionAdapterOptions {
  /** Уже загруженная сессия (если её прокинули через `location.state`). */
  initialSession?: OpeningTrainerSessionDto;
}

export class ServerSessionAdapter implements OpeningTrainerAdapter {
  readonly capabilities: OpeningTrainerAdapterCapabilities = {
    showWrongModal: true,
    showHintArrow: true,
    showStreak: true,
    showRestartLineButton: false,
    showResetProgressButton: false,
    showUndoButton: true,
    showGiveupButton: true,
    showFinishButton: true,
  };

  private session: OpeningTrainerSessionDto | null = null;
  // KS-3274: streak — аппроксимируем по дельтам correct/wrong.
  // Сбрасываем на каждое увеличение `wrongMoves`.
  private lastWrong: number = 0;
  private baselineCorrect: number = 0;
  private streak: number = 0;

  constructor(
    private readonly repertoireId: string,
    private readonly sessionId: string,
    private readonly options: ServerSessionAdapterOptions = {},
  ) {}

  async loadInitial(): Promise<OpeningTrainerInitialState> {
    if (this.options.initialSession) {
      this.session = this.options.initialSession;
    } else {
      const res = await openingTrainerApi.getSession(this.sessionId);
      this.session = res.session;
    }
    this.lastWrong = this.session.wrongMoves;
    this.baselineCorrect = this.session.correctMoves;
    this.streak = 0;
    const lastInPath = this.session.currentPath[
      this.session.currentPath.length - 1
    ];
    return {
      side: this.session.side,
      currentFen: this.session.currentFen,
      lastMoveUci: lastInPath ?? null,
      counters: this.makeCounters(),
    };
  }

  async submitMove(args: SubmitMoveArgs): Promise<OpeningTrainerOutcome> {
    if (!this.session) {
      throw new Error('ServerSessionAdapter: submitMove before loadInitial');
    }
    const responseTimeMs = Math.max(0, Date.now() - args.positionShownAtMs);
    const res = await openingTrainerApi.sendMove(this.sessionId, {
      moveUci: args.moveUci,
      responseTimeMs,
    });
    return this.applyMoveResponse(res);
  }

  async requestHint(): Promise<OpeningTrainerHintOutcome> {
    if (!this.session) {
      throw new Error('ServerSessionAdapter: requestHint before loadInitial');
    }
    const res = await openingTrainerApi.hint(this.sessionId);
    this.session = res.session;
    this.recomputeStreak();
    return {
      moveUci: res.hint.moveUci,
      moveSan: res.hint.moveSan,
      counters: this.makeCounters(),
    };
  }

  async undoLastMove(): Promise<OpeningTrainerInitialState> {
    if (!this.session) {
      throw new Error('ServerSessionAdapter: undoLastMove before loadInitial');
    }
    const res = await openingTrainerApi.undo(this.sessionId);
    this.session = res.session;
    this.recomputeStreak();
    const lastInPath = this.session.currentPath[
      this.session.currentPath.length - 1
    ];
    return {
      side: this.session.side,
      currentFen: res.newFen,
      lastMoveUci: lastInPath ?? null,
      counters: this.makeCounters(),
    };
  }

  async giveup(): Promise<OpeningTrainerOutcome> {
    if (!this.session) {
      throw new Error('ServerSessionAdapter: giveup before loadInitial');
    }
    const res = await openingTrainerApi.giveup(this.sessionId);
    this.session = res.session;
    this.recomputeStreak();
    // KS-3274: giveup = «сдаюсь, покажи правильный ход». Backend
    // инкрементирует `wrongMoves`, возвращает `expectedMoves` и
    // делает ответ бота. Player получит wrong-outcome с botMove —
    // отрисует фидбек «expected: …», применит bot-move и закроет
    // модалку (resetDelayMs=0 — мгновенно).
    return {
      kind: 'wrong',
      newFen: res.botMove ? res.botMove.newFen : res.newFen,
      resetDelayMs: 0,
      expected: res.expectedMoves,
      counters: this.makeCounters(),
      lastMoveUci: res.botMove ? res.botMove.moveUci : null,
      botMove: res.botMove ?? null,
    };
  }

  async finishSession(): Promise<{ resultRoute: string }> {
    if (!this.session) {
      throw new Error(
        'ServerSessionAdapter: finishSession before loadInitial',
      );
    }
    await openingTrainerApi.finish(this.sessionId);
    return {
      resultRoute: `/opening-trainer/${this.repertoireId}/session/${this.sessionId}/result`,
    };
  }

  /**
   * Маршрут к результату, если сессия уже закрылась (tree-complete /
   * session.status === 'finished'). Не делает повторного POST /finish.
   */
  getResultRoute(): string {
    return `/opening-trainer/${this.repertoireId}/session/${this.sessionId}/result`;
  }

  /** Текущий снимок сессии — нужен Player'у, чтобы знать `session.status`. */
  getSessionStatus(): OpeningTrainerSessionDto['status'] | null {
    return this.session?.status ?? null;
  }

  private applyMoveResponse(
    res: Awaited<ReturnType<typeof openingTrainerApi.sendMove>>,
  ): OpeningTrainerOutcome {
    if (isCorrectMove(res)) {
      this.session = res.session;
      this.recomputeStreak();
      return {
        kind: 'correct',
        newFen: res.newFen,
        lastMoveUci: null,
        scoreDelta: res.scoreDelta,
        counters: this.makeCounters(),
        botMove: res.botMove ?? null,
      };
    }
    if (isWrongMove(res)) {
      this.session = res.session;
      this.recomputeStreak();
      return {
        kind: 'wrong',
        newFen: res.session.currentFen,
        resetDelayMs: 0,
        expected: res.expectedMoves,
        counters: this.makeCounters(),
      };
    }
    if (isLineRestartMove(res)) {
      this.session = res.session;
      this.recomputeStreak();
      const lastInPath = res.newPath[res.newPath.length - 1];
      return {
        kind: 'line-restart',
        newFen: res.newFen,
        lastMoveUci: lastInPath ?? null,
        counters: this.makeCounters(),
        botMove: res.botMove ?? null,
      };
    }
    if (isTreeCompleteMove(res)) {
      this.session = res.session;
      this.recomputeStreak();
      return {
        kind: 'tree-complete',
        newFen: res.newFen,
        lastMoveUci: null,
        counters: this.makeCounters(),
        resultRoute: this.getResultRoute(),
      };
    }
    if (isLineCompleteMove(res)) {
      this.session = res.session;
      this.recomputeStreak();
      return {
        kind: 'line-complete',
        newFen: res.newFen,
        lastMoveUci: null,
        counters: this.makeCounters(),
      };
    }
    // exhaustive fallback: backend прислал неизвестный kind — трактуем
    // как «ничего не делать», возвращаем wrong-нулёвку чтобы UI не
    // завис.
    return {
      kind: 'wrong',
      newFen: this.session?.currentFen ?? '',
      resetDelayMs: 0,
      expected: [],
      counters: this.makeCounters(),
    };
  }

  private recomputeStreak(): void {
    if (!this.session) return;
    if (this.session.wrongMoves > this.lastWrong) {
      this.streak = 0;
      this.baselineCorrect = this.session.correctMoves;
    }
    this.streak = Math.max(
      0,
      this.session.correctMoves - this.baselineCorrect,
    );
    this.lastWrong = this.session.wrongMoves;
  }

  private makeCounters(): OpeningTrainerCounters {
    if (!this.session) {
      return {
        score: 0,
        correctMoves: 0,
        wrongMoves: 0,
        hintsUsed: 0,
        streak: 0,
        movesPlayed: 0,
      };
    }
    return {
      score: this.session.score,
      correctMoves: this.session.correctMoves,
      wrongMoves: this.session.wrongMoves,
      hintsUsed: this.session.hintsUsed,
      streak: this.streak,
      movesPlayed: this.session.movesPlayed,
    };
  }
}
