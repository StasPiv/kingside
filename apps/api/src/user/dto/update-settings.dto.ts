import { IsIn } from 'class-validator';

export class UpdateSettingsDto {
  @IsIn(['en', 'ru'])
  locale!: string;
}
