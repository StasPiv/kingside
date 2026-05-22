import { ArrayMaxSize, IsArray, IsOptional, IsString } from 'class-validator';

/**
 * KS-3261. Bulk-check «уже в мастерской» для архив-карточек / broadcast-
 * списков. Принимает массивы lichess/archive id'ов, возвращает map.
 */
export class CheckExistingDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  lichessGameIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  archiveGameIds?: string[];
}
