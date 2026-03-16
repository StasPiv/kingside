import { IsString, MinLength, MaxLength, Matches } from 'class-validator';

export class SetUsernameDto {
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Username may only contain letters, digits and underscores',
  })
  username!: string;
}
