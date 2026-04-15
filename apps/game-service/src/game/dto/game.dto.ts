import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { WsGameMovePayload, WsGameJoinPayload, CreateGameWithBotRequest } from '@kingside/shared';

export class MoveDto implements WsGameMovePayload {
  @IsUUID()
  gameId!: string;

  @IsString()
  uci!: string;
}

export class GameIdDto implements WsGameJoinPayload {
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

  @IsOptional()
  @IsBoolean()
  wasmSupported?: boolean;
}

// 512KB = 524288 bytes; for string length we use same number as an approximation
const MAX_ANALYSIS_PGN_LENGTH = 524288;

export class SaveAnalysisDto {
  @IsString()
  @MaxLength(MAX_ANALYSIS_PGN_LENGTH)
  analysisPgn!: string;
}
