import { IsIn, IsInt, IsString, IsUUID, Max, Min } from 'class-validator';
import type { WsGameMovePayload, CreateGameWithBotRequest } from '@kingside/shared';

export class MoveDto implements WsGameMovePayload {
  @IsUUID()
  gameId!: string;

  @IsString()
  uci!: string;
}

export class GameIdDto {
  @IsUUID()
  gameId!: string;
}

export class CreateGameWithBotDto implements CreateGameWithBotRequest {
  @IsIn(['white', 'black', 'random'])
  color!: 'white' | 'black' | 'random';

  @IsInt()
  @Min(1)
  @Max(20)
  botLevel!: number;

  @IsIn(['bullet', 'blitz', 'rapid', 'classical'])
  timeControl!: 'bullet' | 'blitz' | 'rapid' | 'classical';
}
