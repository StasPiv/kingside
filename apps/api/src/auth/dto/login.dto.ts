import { IsString } from 'class-validator';
import type { LoginRequest } from '@kingside/shared';

export class LoginDto implements LoginRequest {
  @IsString()
  username!: string;

  @IsString()
  password!: string;
}
