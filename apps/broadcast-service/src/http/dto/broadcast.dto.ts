import { IsString, IsNotEmpty } from 'class-validator';

export class SubscribeRoundDto {
  @IsString()
  @IsNotEmpty()
  roundId!: string;
}

export class UnsubscribeRoundDto {
  @IsString()
  @IsNotEmpty()
  roundId!: string;
}
