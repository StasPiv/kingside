import { IsString, MinLength } from 'class-validator';
import type { ChangePasswordRequest } from '@kingside/shared';

export class ChangePasswordDto implements ChangePasswordRequest {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;
}
