import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  Controller,
  Get,
  Patch,
  Post,
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
import { SetUsernameDto } from './dto/set-username.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthService } from '../auth/auth.service';

@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
  ) {}

  @Get('check-username')
  checkUsername(@Query('username') username: string) {
    return this.userService.checkUsername(username);
  }

  @UseGuards(JwtAuthGuard)
  @Post('set-username')
  async setUsername(@Request() req: AuthenticatedRequest, @Body() dto: SetUsernameDto) {
    const { user, isNewUser } = await this.userService.setUsername(req.user.id, dto.username);
    if (isNewUser) {
      const tokens = this.authService.generateTokens(user.id as string, user.username as string, false);
      return { ...user, ...tokens };
    }
    return user;
  }

  @UseGuards(JwtAuthGuard)
  @Get('me/settings')
  getSettings(@Request() req: AuthenticatedRequest) {
    return this.userService.getSettings(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/settings')
  updateSettings(@Request() req: AuthenticatedRequest, @Body() dto: UpdateSettingsDto) {
    return this.userService.updateSettings(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/password')
  changePassword(@Request() req: AuthenticatedRequest, @Body() dto: ChangePasswordDto) {
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
