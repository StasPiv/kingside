import { IsUUID } from 'class-validator';

/**
 * KS-4627 / ADR-142 v2 §2.6. Тело `POST /live-analyses/:slug/switch-analysis`.
 *
 * Минимальный контракт: только `analysisId` (UUID `Analysis.id`).
 * Backend сам читает `Analysis.title` из БД; дерево, FEN и ориентация
 * НЕ передаются — фронт за ними ходит сам в `GET /analyses/:id`
 * после получения WS-события `live-analysis:analysis-switch`. Это
 * убирает дубль данных (Analysis в БД — единственный источник истины)
 * и не нарушает KS-3780 (backend не парсит PGN).
 */
export class SwitchAnalysisDto {
  @IsUUID()
  analysisId!: string;
}
