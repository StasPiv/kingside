import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkshopService } from './workshop.service';
import { ExternalChessService } from './external-chess.service';
import { PrismaService } from '../prisma/prisma.service';

@UseGuards(JwtAuthGuard)
@Controller('workshop')
export class WorkshopController {
  constructor(
    private readonly workshopService: WorkshopService,
    private readonly externalChess: ExternalChessService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('pgn-files')
  @UseInterceptors(FileInterceptor('file'))
  importPgn(
    @Request() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.workshopService.importPgn(req.user.id, file);
  }

  @Get('pgn-files')
  findAllImports(@Request() req: AuthenticatedRequest) {
    return this.workshopService.findAllImports(req.user.id);
  }

  @Get('pgn-files/:id/games')
  findImportGames(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.workshopService.findImportGames(req.user.id, id);
  }

  @Delete('pgn-files/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteFile(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.workshopService.deleteFile(req.user.id, id);
  }

  @Patch('pgn-files/:id')
  renameFile(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { fileName: string },
  ) {
    return this.workshopService.renameFile(req.user.id, id, body.fileName);
  }

  @Delete('pgn-files/:fileId/games/:gameId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteGame(
    @Request() req: AuthenticatedRequest,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Param('gameId', ParseUUIDPipe) gameId: string,
  ) {
    return this.workshopService.deleteGame(req.user.id, fileId, gameId);
  }

  /**
   * POST /api/workshop/import-external — import games from chess.com or lichess.
   */
  @Post('import-external')
  async importExternal(
    @Request() req: AuthenticatedRequest,
    @Body() body: {
      platform: 'chesscom' | 'lichess';
      year: number;
      month: number;
      maxGames?: number;
      timeClass?: string;
    },
  ) {
    const { platform, year, month, maxGames, timeClass } = body;
    if (!platform || !year || !month) {
      throw new BadRequestException('platform, year, month required');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: req.user.id },
      select: { chesscomUsername: true, lichessUsername: true },
    });

    let pgn: string;
    let fileName: string;

    if (platform === 'chesscom') {
      if (!user.chesscomUsername) throw new BadRequestException('chess.com username not set');
      pgn = await this.externalChess.fetchChesscomGames(user.chesscomUsername, year, month, timeClass);
      fileName = `chess.com ${user.chesscomUsername} ${year}-${String(month).padStart(2, '0')}`;
    } else if (platform === 'lichess') {
      if (!user.lichessUsername) throw new BadRequestException('lichess username not set');
      pgn = await this.externalChess.fetchLichessGames(user.lichessUsername, year, month, maxGames);
      fileName = `lichess ${user.lichessUsername} ${year}-${String(month).padStart(2, '0')}`;
    } else {
      throw new BadRequestException('platform must be chesscom or lichess');
    }

    if (!pgn || pgn.trim().length === 0) {
      return { id: null, fileName, gamesCount: 0 };
    }

    // Create a fake Multer file to reuse importPgn
    const fakeFile = {
      buffer: Buffer.from(pgn, 'utf-8'),
      originalname: `${fileName}.pgn`,
    } as Express.Multer.File;

    return this.workshopService.importPgn(req.user.id, fakeFile);
  }
}
