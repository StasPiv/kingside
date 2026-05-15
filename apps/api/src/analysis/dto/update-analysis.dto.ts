import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateAnalysisDto {
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
  @IsInt()
  @Min(0)
  currentPosition?: number | null;

  // KS-3045: ориентация доски, сохранённая автором.
  // `null` явно разрешён — сброс на дефолт фронта.
  // `@IsOptional()` пропускает undefined и null, `@IsIn` валидирует
  // только когда значение пришло строкой → 'foo' → 400.
  @IsOptional()
  @IsIn(['white', 'black', null])
  boardOrientation?: 'white' | 'black' | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  @MaxLength(30, { each: true })
  tags?: string[];
}
