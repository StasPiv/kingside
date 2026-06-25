import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * KS-4627 / ADR-142 §2.6. Тело `POST /live-analyses/:slug/switch-analysis`.
 *
 * Валидация:
 *   - `analysisId` — UUID; сервис ещё раз проверит, что Analysis
 *     существует и принадлежит actor'у (`Analysis.userId === user.id`),
 *     иначе 403.
 *   - `tree` — JSON-сериализованное дерево анализа (тот же формат, что
 *     у `state-patch`). Hard cap 256 KB (262 144 байт), иначе 400
 *     (`tree_too_large`). Не парсится сервером — за корректность JSON
 *     отвечает фронт (KS-3780).
 *   - `startingFen` — опц. строка ≤ 120 (длина FEN с запасом). Глубокая
 *     валидация FEN не нужна: бэк не интерпретирует позицию (KS-3780).
 *   - `orientation` — 'white' | 'black'.
 *   - `title` — опц. строка ≤ 200 символов (для UI зрителя; ограничено,
 *     чтобы tree не «пухнул» от чрезмерного заголовка).
 *   - `currentGlobalIndex` — целое ≥ 0.
 */
export class SwitchAnalysisDto {
  @IsUUID()
  analysisId!: string;

  /**
   * KS-3780. Длина — UTF-16 code units (`String.prototype.length`),
   * как и в `state-patch`. 262 144 байт = 256 KB.
   */
  @IsOptional()
  @IsString()
  @MaxLength(262_144)
  tree?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  startingFen?: string;

  @IsOptional()
  @IsIn(['white', 'black'])
  orientation?: 'white' | 'black';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  currentGlobalIndex?: number;
}
