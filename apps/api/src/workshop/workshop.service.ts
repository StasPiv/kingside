import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parsePgnGames } from './pgn.parser';

@Injectable()
export class WorkshopService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parse uploaded PGN file and persist as PgnImport + PgnImportGames.
   */
  async importPgn(
    userId: string,
    file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('PGN file is required');
    }

    const content = file.buffer.toString('utf-8');
    const games = parsePgnGames(content);

    if (games.length === 0) {
      throw new BadRequestException('No games found in PGN file');
    }

    const fileName = file.originalname.replace(/\.pgn$/i, '');

    const pgnImport = await this.prisma.pgnImport.create({
      data: {
        userId,
        fileName,
        games: {
          create: games.map((g, i) => ({
            pgn: g.pgn,
            white: g.white,
            black: g.black,
            result: g.result,
            date: g.date,
            opening: g.opening,
            position: i,
          })),
        },
      },
      include: {
        _count: { select: { games: true } },
      },
    });

    return {
      id: pgnImport.id,
      fileName: pgnImport.fileName,
      gamesCount: pgnImport._count.games,
      createdAt: pgnImport.createdAt,
    };
  }

  async findAllImports(userId: string) {
    const imports = await this.prisma.pgnImport.findMany({
      where: { userId },
      select: {
        id: true,
        fileName: true,
        createdAt: true,
        _count: { select: { games: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return imports.map((imp) => ({
      id: imp.id,
      fileName: imp.fileName,
      gamesCount: imp._count.games,
      createdAt: imp.createdAt,
    }));
  }

  async findImportGames(userId: string, importId: string) {
    const pgnImport = await this.prisma.pgnImport.findUnique({
      where: { id: importId },
    });

    if (!pgnImport) throw new NotFoundException('PGN import not found');
    if (pgnImport.userId !== userId) throw new ForbiddenException();

    return this.prisma.pgnImportGame.findMany({
      where: { importId },
      select: {
        id: true,
        white: true,
        black: true,
        result: true,
        date: true,
        opening: true,
        position: true,
        pgn: true,
      },
      orderBy: { position: 'asc' },
    });
  }

  async deleteFile(userId: string, fileId: string) {
    const file = await this.prisma.pgnImport.findUnique({ where: { id: fileId } });
    if (!file) throw new NotFoundException('PGN import not found');
    if (file.userId !== userId) throw new ForbiddenException();

    await this.prisma.pgnImport.delete({ where: { id: fileId } });
  }

  async renameFile(userId: string, fileId: string, fileName: string) {
    const file = await this.prisma.pgnImport.findUnique({ where: { id: fileId } });
    if (!file) throw new NotFoundException('PGN import not found');
    if (file.userId !== userId) throw new ForbiddenException();

    const updated = await this.prisma.pgnImport.update({
      where: { id: fileId },
      data: { fileName },
      include: { _count: { select: { games: true } } },
    });

    return {
      id: updated.id,
      fileName: updated.fileName,
      gamesCount: updated._count.games,
      createdAt: updated.createdAt,
    };
  }

  async deleteGame(userId: string, fileId: string, gameId: string) {
    const file = await this.prisma.pgnImport.findUnique({ where: { id: fileId } });
    if (!file) throw new NotFoundException('PGN import not found');
    if (file.userId !== userId) throw new ForbiddenException();

    const game = await this.prisma.pgnImportGame.findUnique({ where: { id: gameId } });
    if (!game || game.importId !== fileId) throw new NotFoundException('Game not found');

    await this.prisma.pgnImportGame.delete({ where: { id: gameId } });

    // If no games left, delete the file too
    const remaining = await this.prisma.pgnImportGame.count({ where: { importId: fileId } });
    if (remaining === 0) {
      await this.prisma.pgnImport.delete({ where: { id: fileId } });
    }
  }
}
