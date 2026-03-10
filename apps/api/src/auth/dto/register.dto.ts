import { IsString, IsEmail, MinLength, MaxLength, Matches } from 'class-validator';
import type { RegisterRequest } from '@kingside/shared';

export class RegisterDto implements RegisterRequest {
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
