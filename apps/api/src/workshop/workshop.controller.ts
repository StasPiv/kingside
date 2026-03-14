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

  @Post('pgn-import')
  @UseInterceptors(FileInterceptor('file'))
  importPgn(
    @Request() req: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.workshopService.importPgn(req.user.id, file);
  }

  @Get('pgn-imports')
  findAllImports(@Request() req: any) {
    return this.workshopService.findAllImports(req.user.id);
  }

  @Get('pgn-imports/:id/games')
  findImportGames(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.workshopService.findImportGames(req.user.id, id);
  }
}
