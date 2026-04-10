import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { BlockService } from './block.service';
import { EcoService } from '../game/eco.service';

@Module({
  providers: [UserService, BlockService, EcoService],
  exports: [UserService, BlockService],
})
export class UserModule {}
