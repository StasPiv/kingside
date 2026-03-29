import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parsePgnGames } from './pgn.parser';

@Injectable()
export class WorkshopService {
  private readonly logger = new Logger(WorkshopService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parse uploaded PGN file and persist as PgnImport + PgnImportGames.
   * If a PgnImport with the same fileName already exists for this user,
   * appends only new (non-duplicate) games to it.
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

    // Check for existing import with same fileName
    const existing = await this.prisma.pgnImport.findFirst({
      where: { userId, fileName },
      include: { games: { select: { pgn: true } } },
    });

    this.logger.log(
      `importPgn: fileName="${fileName}", parsed=${games.length}, existingImport=${existing?.id ?? 'none'}, existingGames=${existing?.games.length ?? 0}`,
    );

    if (existing) {
      // Deduplicate using a normalized key: white+black+date+result+moves-line
      const gameKey = (pgn: string) => {
        const white = pgn.match(/\[White\s+"([^"]*)"\]/)?.[1] ?? '';
        const black = pgn.match(/\[Black\s+"([^"]*)"\]/)?.[1] ?? '';
        const date = pgn.match(/\[Date\s+"([^"]*)"\]/)?.[1] ?? '';
        const result = pgn.match(/\[Result\s+"([^"]*)"\]/)?.[1] ?? '';
        // Extract moves line (everything after empty line, without result at end)
        const movesMatch = pgn.match(/\n\n([\s\S]+)/);
        const moves = movesMatch ? movesMatch[1].replace(/\s+/g, ' ').trim() : '';
        return `${white}|${black}|${date}|${result}|${moves}`;
      };
      const existingKeys = new Set(existing.games.map((g) => gameKey(g.pgn)));
      const newGames = games.filter((g) => !existingKeys.has(gameKey(g.pgn)));

      this.logger.log(`importPgn: dedup result — ${newGames.length} new games out of ${games.length}`);

      if (newGames.length === 0) {
        const total = await this.prisma.pgnImportGame.count({ where: { importId: existing.id } });
        return { id: existing.id, fileName, gamesCount: total, createdAt: existing.createdAt, added: 0 };
      }

      // Get max position for ordering
      const maxPos = await this.prisma.pgnImportGame.aggregate({
        where: { importId: existing.id },
        _max: { position: true },
      });
      const startPos = (maxPos._max.position ?? -1) + 1;

      await this.prisma.pgnImportGame.createMany({
        data: newGames.map((g, i) => ({
          importId: existing.id,
          pgn: g.pgn,
          white: g.white,
          black: g.black,
          result: g.result,
          date: g.date,
          opening: g.opening,
          position: startPos + i,
        })),
      });

      const total = await this.prisma.pgnImportGame.count({ where: { importId: existing.id } });
      return { id: existing.id, fileName, gamesCount: total, createdAt: existing.createdAt, added: newGames.length };
    }

    // No existing import — create new
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
      added: pgnImport._count.games,
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
      orderBy: { position: 'desc' },
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
