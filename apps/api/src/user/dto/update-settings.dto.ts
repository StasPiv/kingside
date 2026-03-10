import { IsIn, IsBoolean, IsOptional } from 'class-validator';
import type { UpdateSettingsRequest } from '@kingside/shared';
import { BOARD_THEMES, PIECE_SETS } from '@kingside/shared';

export class UpdateSettingsDto implements UpdateSettingsRequest {
  @IsOptional()
  @IsIn(['en', 'ru'])
  locale?: 'en' | 'ru';

  @IsOptional()
  @IsIn(BOARD_THEMES)
  boardTheme?: typeof BOARD_THEMES[number];

  @IsOptional()
  @IsIn(PIECE_SETS)
  pieceSet?: typeof PIECE_SETS[number];

  @IsOptional()
  @IsBoolean()
  soundEnabled?: boolean;
}
