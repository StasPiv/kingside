import { IsIn, IsInt, IsString, IsUUID, Max, Min } from 'class-validator';

export class MoveDto {
  @IsUUID()
  gameId!: string;

  @IsString()
  uci!: string;
}

export class GameIdDto {
  @IsUUID()
  gameId!: string;
}

export class CreateGameWithBotDto {
  @IsIn(['white', 'black', 'random'])
  color!: 'white' | 'black' | 'random';

  @IsInt()
  @Min(1)
  @Max(8)
  botLevel!: number;

  @IsIn(['bullet', 'blitz', 'rapid', 'classical'])
  timeControl!: 'bullet' | 'blitz' | 'rapid' | 'classical';
}
