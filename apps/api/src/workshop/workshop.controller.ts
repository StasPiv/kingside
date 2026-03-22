import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
}
