import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateAnalysisDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  pgn?: string;

  @IsOptional()
  @IsString()
  fen?: string;

  @IsOptional()
  @IsString()
  @IsIn(['analysis', 'game_review', 'puzzle'])
  category?: string;

  /**
   * KS-3261. Источник партии для дедупа при повторном открытии «В мастерской»
   * из Архива/Трансляции.
   *
   * Если передан `lichessGameId` — backend ищет существующий анализ
   * пользователя с тем же `source_hash = 'lichess:<id>'`. При hit'е
   * возвращается существующий + `last_opened_at = now()`, новый не создаётся.
   *
   * Base62, 8 символов — стандарт Lichess game-id.
   */
  @IsOptional()
  @IsString()
  @Length(1, 32)
  lichessGameId?: string;

  /**
   * KS-3261. То же что lichessGameId, но для наших archive_games.
   * UUID наш id из `archive_games.id`.
   */
  @IsOptional()
  @IsUUID()
  archiveGameId?: string;
}
