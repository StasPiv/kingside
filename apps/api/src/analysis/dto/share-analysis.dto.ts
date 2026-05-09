import { IsBoolean } from 'class-validator';

/**
 * KS-2602 (ADR-051 §3 share-3). Body для `PATCH /analyses/:id/share` —
 * единая точка toggle публичности анализа автором.
 */
export class ShareAnalysisDto {
  @IsBoolean()
  isPublic!: boolean;
}
