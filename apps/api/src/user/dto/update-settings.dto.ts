import { IsIn } from 'class-validator';
import type { UpdateSettingsRequest, Locale } from '@kingside/shared';

export class UpdateSettingsDto implements UpdateSettingsRequest {
  @IsIn(['en', 'ru'])
  locale!: Locale;
}
