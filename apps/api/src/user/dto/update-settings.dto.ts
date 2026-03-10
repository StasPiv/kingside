import { IsIn, IsBoolean, IsOptional } from 'class-validator';
import type { UpdateSettingsRequest, Locale } from '@kingside/shared';

export class UpdateSettingsDto implements UpdateSettingsRequest {
  @IsOptional()
  @IsIn(['en', 'ru'])
  locale?: Locale;

  @IsOptional()
  @IsIn(['default', 'green', 'blue', 'brown'])
  boardTheme?: string;

  @IsOptional()
  @IsIn(['standard', 'neo', 'alpha', 'cburnett'])
  pieceSet?: string;

  @IsOptional()
  @IsBoolean()
  soundEnabled?: boolean;
}
