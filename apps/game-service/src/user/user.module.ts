import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { BlockService } from './block.service';

/**
 * Minimal UserModule for Game Service — only services needed by game logic.
 * No controllers, no workshop dependency.
 */
@Module({
  providers: [UserService, BlockService],
  exports: [UserService, BlockService],
})
export class UserModule {}
