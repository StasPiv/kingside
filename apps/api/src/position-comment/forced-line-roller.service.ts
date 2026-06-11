/**
 * KS-4070 follow-up. Фильтр форсированных линий — только по Maia.
 *
 * Идея: модель плохо комментирует позиции «в середине размена», где
 * у одной из сторон под боем висит фигура, и очевидный ответ — её
 * взять/уйти, после чего статика позиции совсем другая. Решение —
 * автоматически проиграть очевидные для человека ходы и комментировать
 * уже итоговую позицию.
 *
 * Очевидным ход признаётся через Maia-3: запрашиваем policy и, если
 * top-1 ход имеет вероятность ≥ `POSITION_COMMENT_MAIA_FORCED_PROBABILITY`
 * (по умолчанию 0.99), играем его и идём дальше. Stockfish тут НЕ
 * используется — нагружать сервер шахматной программой не нужно,
 * Maia сама определяет, насколько ход очевиден игроку выбранного ELO.
 *
 * Если Maia недоступна (модель не загрузилась) — сервис тихо ничего
 * не делает: финальная FEN равна исходной. Это безопасное поведение,
 * `PositionCommentService` продолжит работать как раньше.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Chess } from 'chess.js';
import { MaiaService } from './maia.service';

export interface ForcedLineResult {
  /** Исходный FEN, какой пришёл от клиентской части. */
  initialFen: string;
  /** Список UCI-ходов, проигранных автоматически. */
  playedMoves: string[];
  /** FEN после прокатки. Если ничего не игралось — равен `initialFen`. */
  finalFen: string;
  /** Лог решений по каждому шагу — для диагностики и тестов. */
  trace: Array<{
    fen: string;
    maiaTop?: string;
    maiaProb?: number;
    decision: 'forced' | 'not-forced' | 'maia-unavailable' | 'game-over';
  }>;
}

@Injectable()
export class ForcedLineRollerService {
  private readonly logger = new Logger(ForcedLineRollerService.name);
  private readonly maxPlies: number;
  private readonly maiaProbThreshold: number;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly maia: MaiaService,
  ) {
    this.enabled =
      this.config.get<string>(
        'POSITION_COMMENT_FORCED_LINE_ENABLED',
        'true',
      ) !== 'false';
    this.maxPlies = parseInt(
      this.config.get<string>(
        'POSITION_COMMENT_FORCED_LINE_MAX_PLIES',
        '6',
      ),
      10,
    );
    this.maiaProbThreshold = parseFloat(
      this.config.get<string>(
        'POSITION_COMMENT_MAIA_FORCED_PROBABILITY',
        '0.9',
      ),
    );
  }

  /**
   * Прокатывает форсированную линию от `fen`. Безопасен при сбоях
   * Maia/chess.js: при любой ошибке возвращает результат «ничего не
   * сыграно» (`finalFen === initialFen`).
   */
  async roll(fen: string): Promise<ForcedLineResult> {
    const result: ForcedLineResult = {
      initialFen: fen,
      playedMoves: [],
      finalFen: fen,
      trace: [],
    };
    if (!this.enabled) return result;

    let chess: Chess;
    try {
      chess = new Chess(fen);
    } catch (e) {
      this.logger.warn(
        `forced-line: invalid FEN ${fen}: ${(e as Error).message}`,
      );
      return result;
    }

    for (let ply = 0; ply < this.maxPlies; ply++) {
      if (chess.isGameOver()) {
        result.trace.push({ fen: chess.fen(), decision: 'game-over' });
        break;
      }
      const currentFen = chess.fen();
      const step = await this.evaluateStep(currentFen);
      result.trace.push({ fen: currentFen, ...step });
      if (step.decision !== 'forced' || !step.maiaTop) break;
      try {
        chess.move(step.maiaTop);
      } catch (e) {
        this.logger.warn(
          `forced-line: chess.js refused move ${step.maiaTop}: ${(e as Error).message}`,
        );
        break;
      }
      result.playedMoves.push(step.maiaTop);
      result.finalFen = chess.fen();
    }
    return result;
  }

  private async evaluateStep(fen: string): Promise<{
    maiaTop?: string;
    maiaProb?: number;
    decision: 'forced' | 'not-forced' | 'maia-unavailable' | 'game-over';
  }> {
    const maia = await this.maia.predict(fen);
    if (!maia || maia.policy.length === 0) {
      return { decision: 'maia-unavailable' };
    }
    const top = maia.policy[0];
    if (top.probability < this.maiaProbThreshold) {
      return {
        maiaTop: top.move,
        maiaProb: top.probability,
        decision: 'not-forced',
      };
    }
    return {
      maiaTop: top.move,
      maiaProb: top.probability,
      decision: 'forced',
    };
  }
}
