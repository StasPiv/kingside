import { IsString, IsUUID } from 'class-validator';

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
