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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkshopService } from './workshop.service';

@UseGuards(JwtAuthGuard)
@Controller('workshop')
export class WorkshopController {
  constructor(private readonly workshopService: WorkshopService) {}

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
}
