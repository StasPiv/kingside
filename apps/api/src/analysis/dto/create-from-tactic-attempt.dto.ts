/**
 * KS-4607. DTO для `POST /analyses/from-tactic-attempt`. Фронт передаёт
 * только id попытки из `tactic_puzzle_attempts`, backend собирает PGN
 * из связки `attempt → puzzle` (включая `[FEN]`, теги партии-источника
 * и movetext с ходами пользователя). Дедуп — через тот же source-hash
 * механизм, что и обычный `POST /analyses` (`[FEN]` в hash, KS-4552).
 */
import { IsUUID } from 'class-validator';

export class CreateFromTacticAttemptDto {
  @IsUUID()
  attemptId!: string;
}
