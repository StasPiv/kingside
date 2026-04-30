import { IsString, IsUUID } from 'class-validator';
import { SyntheticTokenRequest } from '@kingside/shared';

/**
 * KS-2182. DTO `POST /api/internal/auth/synthetic-token`. Тип
 * `SyntheticTokenRequest` лежит в `@kingside/shared` (см.
 * `packages/shared/src/types/internal-auth.ts`) — этот класс лишь
 * добавляет class-validator-декораторы на runtime.
 */
export class SyntheticTokenDto implements SyntheticTokenRequest {
  @IsString()
  @IsUUID()
  botUserId!: string;
}
