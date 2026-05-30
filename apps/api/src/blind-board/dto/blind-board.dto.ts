/**
 * KS-3441 / ADR-088 §11 B2. DTO blind-board с class-validator.
 */
import { IsString, Matches, IsIn } from 'class-validator';

/** Клетка `[a-h][1-8]`. */
export class SubmitBlindBoardAnswerBodyDto {
  @IsString()
  @Matches(/^[a-h][1-8]$/, { message: 'square must match [a-h][1-8]' })
  square!: string;

  @IsIn(['Q', 'R', 'B', 'N'])
  pieceType!: 'Q' | 'R' | 'B' | 'N';
}
