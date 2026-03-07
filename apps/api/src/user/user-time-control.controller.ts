import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserTimeControlService } from './user-time-control.service';
import { CreateTimeControlDto } from './dto/create-time-control.dto';

@Controller('users/me/time-controls')
@UseGuards(JwtAuthGuard)
export class UserTimeControlController {
  constructor(private readonly service: UserTimeControlService) {}

  @Get()
  findAll(@Request() req: { user: { id: string } }) {
    return this.service.findAllByUser(req.user.id);
  }

  @Post()
  create(
    @Request() req: { user: { id: string } },
    @Body() dto: CreateTimeControlDto,
  ) {
    return this.service.create(req.user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Request() req: { user: { id: string } },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(req.user.id, id);
  }
}
