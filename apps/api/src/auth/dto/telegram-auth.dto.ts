import { IsString, IsNumber, IsOptional } from 'class-validator';

export class TelegramAuthDto {
  @IsNumber()
  id!: number;

  @IsString()
  first_name!: string;

  @IsString()
  @IsOptional()
  last_name?: string;

  @IsString()
  @IsOptional()
  username?: string;

  @IsString()
  @IsOptional()
  photo_url?: string;

  @IsNumber()
  auth_date!: number;

  @IsString()
  hash!: string;
}
