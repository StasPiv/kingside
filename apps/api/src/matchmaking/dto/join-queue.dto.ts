import { IsInt, Min, Max } from 'class-validator';
import { MAX_INITIAL_TIME_SEC, MAX_INCREMENT_SEC } from '@kingside/shared';
import type { WsMatchmakingJoinPayload } from '@kingside/shared';

export class JoinQueueDto implements WsMatchmakingJoinPayload {
  @IsInt()
  @Min(1)
  @Max(MAX_INITIAL_TIME_SEC)
  timeInitial!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_INCREMENT_SEC)
  increment!: number;
}
