import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { UserService } from './user.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SearchGamesDto } from './dto/search-games.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @UseGuards(JwtAuthGuard)
  @Patch('me/settings')
  updateSettings(@Request() req: any, @Body() dto: UpdateSettingsDto) {
    return this.userService.updateSettings(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/password')
  changePassword(@Request() req: any, @Body() dto: ChangePasswordDto) {
    return this.userService.changePassword(req.user.id, dto);
  }

  @Get(':id')
  getProfile(@Param('id', ParseUUIDPipe) id: string) {
    return this.userService.getProfile(id);
  }

  @Get(':id/puzzle-rush-stats')
  getPuzzleRushStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.userService.getPuzzleRushStats(id);
  }

  @Get(':id/games')
  getUserGames(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: SearchGamesDto,
  ) {
    return this.userService.getUserGames(id, dto);
  }
}
