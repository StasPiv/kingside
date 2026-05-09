import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAnalysisDto } from './dto/create-analysis.dto';
import { UpdateAnalysisDto } from './dto/update-analysis.dto';

@Injectable()
export class AnalysisService implements OnModuleInit {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.backfillMetadata();
  }

  /**
   * Backfill metadata fields for existing analyses that have PGN but no metadata.
   * Runs once at startup.
   */
  private async backfillMetadata(): Promise<void> {
    const stale = await this.prisma.analysis.findMany({
      where: {
        pgn: { not: null },
        white: null,
        event: null,
        headline: null,
      },
      select: { id: true, pgn: true },
    });

    if (stale.length === 0) return;

    this.logger.log(`Backfilling metadata for ${stale.length} analyses...`);

    for (const row of stale) {
      const meta = this.extractMetadata(row.pgn ?? undefined);
      const headline = this.buildHeadline(row.pgn ?? undefined);
      await this.prisma.analysis.update({
        where: { id: row.id },
        data: {
          headline,
          opening: meta.opening ?? null,
          event: meta.event ?? null,
          site: meta.site ?? null,
          pgnDate: meta.pgnDate ?? null,
          round: meta.round ?? null,
          white: meta.white ?? null,
          black: meta.black ?? null,
          whiteElo: meta.whiteElo ?? null,
          blackElo: meta.blackElo ?? null,
          result: meta.result ?? null,
        },
      });
    }

    this.logger.log(`Backfill complete: ${stale.length} analyses updated`);
  }

  /**
   * Extract opening name from PGN headers.
   * Looks for [Opening "..."] tag.
   */
  private extractOpening(pgn?: string): string | null {
    if (!pgn) return null;
    const match = pgn.match(/\[Opening\s+"([^"]+)"\]/);
    return match ? match[1] : null;
  }

  /**
   * Extract a PGN header value by key.
   */
  private extractHeader(pgn: string, key: string): string | null {
    const re = new RegExp(`\\[${key}\\s+"([^"]*)"\\]`);
    const m = pgn.match(re);
    return m ? m[1] : null;
  }

  /**
   * Build headline from PGN headers.
   * e.g. "Fischer (2785) 1-0 Spassky (2660)"
   * Falls back to null if no player info found.
   */
  private buildHeadline(pgn?: string): string | null {
    if (!pgn) return null;

    const white = this.extractHeader(pgn, 'White');
    const black = this.extractHeader(pgn, 'Black');
    if (!white && !black) return null;

    const whiteElo = this.extractHeader(pgn, 'WhiteElo');
    const blackElo = this.extractHeader(pgn, 'BlackElo');
    const result = this.extractHeader(pgn, 'Result');

    const wPart = white
      ? whiteElo && whiteElo !== '?' ? `${white} (${whiteElo})` : white
      : '?';
    const bPart = black
      ? blackElo && blackElo !== '?' ? `${black} (${blackElo})` : black
      : '?';
    const rPart = result && result !== '*' ? result : 'vs';

    return `${wPart} ${rPart} ${bPart}`;
  }

  /**
   * Extract all standard PGN metadata fields.
   */
  private extractMetadata(pgn?: string) {
    if (!pgn) return {};
    return {
      white: this.extractHeader(pgn, 'White'),
      black: this.extractHeader(pgn, 'Black'),
      whiteElo: this.extractHeader(pgn, 'WhiteElo'),
      blackElo: this.extractHeader(pgn, 'BlackElo'),
      result: this.extractHeader(pgn, 'Result'),
      event: this.extractHeader(pgn, 'Event'),
      site: this.extractHeader(pgn, 'Site'),
      pgnDate: this.extractHeader(pgn, 'Date'),
      round: this.extractHeader(pgn, 'Round'),
      opening: this.extractOpening(pgn),
    };
  }

  /**
   * Generate default title: "New analysis YYYY-MM-DD HH:mm:ss"
   */
  private defaultTitle(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `New analysis ${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }

  async create(userId: string, dto: CreateAnalysisDto) {
    const now = new Date();
    const title = dto.title ?? this.defaultTitle(now);
    const headline = this.buildHeadline(dto.pgn);
    const meta = this.extractMetadata(dto.pgn);

    return this.prisma.analysis.create({
      data: {
        userId,
        title,
        headline,
        pgn: dto.pgn ?? null,
        fen: dto.fen ?? null,
        opening: meta.opening ?? null,
        event: meta.event ?? null,
        site: meta.site ?? null,
        pgnDate: meta.pgnDate ?? null,
        round: meta.round ?? null,
        white: meta.white ?? null,
        black: meta.black ?? null,
        whiteElo: meta.whiteElo ?? null,
        blackElo: meta.blackElo ?? null,
        result: meta.result ?? null,
        category: dto.category ?? 'analysis',
      },
    });
  }

  async findAll(userId: string) {
    const analyses = await this.prisma.analysis.findMany({
      where: { userId },
      select: {
        id: true,
        title: true,
        headline: true,
        opening: true,
        event: true,
        white: true,
        black: true,
        result: true,
        category: true,
        tags: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return analyses.map((a) => ({
      ...a,
      tags: a.tags ? a.tags.split(' ').filter(Boolean) : [],
    }));
  }

  private buildWordFilter(word: string) {
    return {
      OR: [
        { headline: { contains: word, mode: 'insensitive' as const } },
        { title: { contains: word, mode: 'insensitive' as const } },
        { opening: { contains: word, mode: 'insensitive' as const } },
        { event: { contains: word, mode: 'insensitive' as const } },
        { white: { contains: word, mode: 'insensitive' as const } },
        { black: { contains: word, mode: 'insensitive' as const } },
        { site: { contains: word, mode: 'insensitive' as const } },
      ],
    };
  }

  async search(userId: string, query: string, limit = 20) {
    const safeLimit = Math.min(limit, 50);
    const words = query.trim().split(/\s+/).filter(Boolean);

    // Each word must match at least one field (AND between words, OR between fields)
    const wordFilters = words.length > 0
      ? words.map((w) => this.buildWordFilter(w))
      : [];

    const analyses = await this.prisma.analysis.findMany({
      where: {
        userId,
        ...(wordFilters.length > 0 && { AND: wordFilters }),
      },
      select: {
        id: true,
        title: true,
        headline: true,
        opening: true,
        category: true,
        tags: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
    });
    return analyses.map((a) => ({
      ...a,
      tags: a.tags ? a.tags.split(' ').filter(Boolean) : [],
    }));
  }

  async findOne(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (analysis.userId !== userId) throw new ForbiddenException();
    return {
      ...analysis,
      tags: analysis.tags ? analysis.tags.split(' ').filter(Boolean) : [],
    };
  }

  /**
   * KS-2601 (ADR-051 §3 share-2). Read-only публичная проекция анализа.
   *
   * Возврат:
   *  - 404 (NotFoundException) если запись не найдена ИЛИ `isPublic=false`.
   *    Не светим существование непубличной записи — это контракт acceptance.
   *  - 200 + тело без `userId` (не отдаём автора анонимам — расширим
   *    отдельной задачей, если потребуется показывать username).
   */
  async findPublic(id: string) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis || !analysis.isPublic) {
      throw new NotFoundException('Analysis not found');
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId: _userId, ...publicProjection } = analysis;
    return {
      ...publicProjection,
      tags: analysis.tags ? analysis.tags.split(' ').filter(Boolean) : [],
    };
  }

  async update(userId: string, id: string, dto: UpdateAnalysisDto) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (analysis.userId !== userId) throw new ForbiddenException();

    // KS-2404: ранее любая meta-нормализация затирала existing headers
    // на null, если в новом dto.pgn нет [White ...]/[Event ...] и т.п.
    // Это пересекалось со stale-state-багом фронта (KS-2403):
    // фронт мог прислать только moves без headers — и валидные
    // event/white/black-поля в БД теряли значения.
    //
    // Фикс: обновляем поле header'а только если новое значение **не
    // null**. Если в новом pgn header'а нет, оставляем то, что было.
    // Это не покрывает случай «фронт прислал stale moves c HEADERS
    // от другой игры» (там headers перезатрутся под stale-headers,
    // и это правильно — мы доверяем тому, что прислал клиент). Но
    // защищает от потери headers при moves-only PATCH.
    const meta = dto.pgn !== undefined ? this.extractMetadata(dto.pgn) : null;
    const headerUpdate = meta
      ? {
          // headline пересчитываем только если хотя бы один из
          // White/Black есть — иначе buildHeadline вернул бы null и
          // затёр существующий headline.
          ...(meta.white || meta.black
            ? { headline: this.buildHeadline(dto.pgn) }
            : {}),
          ...(meta.opening !== null && { opening: meta.opening }),
          ...(meta.event !== null && { event: meta.event }),
          ...(meta.site !== null && { site: meta.site }),
          ...(meta.pgnDate !== null && { pgnDate: meta.pgnDate }),
          ...(meta.round !== null && { round: meta.round }),
          ...(meta.white !== null && { white: meta.white }),
          ...(meta.black !== null && { black: meta.black }),
          ...(meta.whiteElo !== null && { whiteElo: meta.whiteElo }),
          ...(meta.blackElo !== null && { blackElo: meta.blackElo }),
          ...(meta.result !== null && { result: meta.result }),
        }
      : {};

    // KS-2404 telemetry: если фронт прислал PGN с headers, отличными
    // от тех, что в БД (white/black/round) — лог warn для прод-
    // диагностики stale-state регрессий. Не блокирующее.
    if (
      meta &&
      ((meta.white && analysis.white && meta.white !== analysis.white) ||
        (meta.black && analysis.black && meta.black !== analysis.black) ||
        (meta.round && analysis.round && meta.round !== analysis.round))
    ) {
      this.logger.warn(
        `analysis update headers diverge id=${id} user=${userId} ` +
          `was: ${analysis.white}/${analysis.black} round=${analysis.round} ` +
          `now: ${meta.white}/${meta.black} round=${meta.round}`,
      );
    }

    return this.prisma.analysis.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.pgn !== undefined && { pgn: dto.pgn }),
        ...(dto.fen !== undefined && { fen: dto.fen }),
        ...(dto.currentPosition !== undefined && { currentPosition: dto.currentPosition }),
        ...(dto.tags !== undefined && { tags: dto.tags.join(' ') }),
        ...headerUpdate,
      },
    });
  }

  async exportPgn(userId: string, ids: string[]): Promise<string> {
    const analyses = await this.prisma.analysis.findMany({
      where: { id: { in: ids }, userId },
      orderBy: { createdAt: 'desc' },
    });

    if (analyses.length === 0) {
      throw new NotFoundException('No analyses found');
    }

    return analyses
      .map((a) => {
        const headers: string[] = [];
        headers.push(`[Event "${a.title}"]`);
        headers.push(`[Site "Kingside"]`);
        const d = a.createdAt;
        headers.push(`[Date "${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}"]`);
        if (a.fen) {
          headers.push(`[FEN "${a.fen}"]`);
          headers.push(`[SetUp "1"]`);
        }
        if (a.opening) {
          headers.push(`[Opening "${a.opening}"]`);
        }
        headers.push(`[Result "*"]`);
        const moves = a.pgn ?? '*';
        return headers.join('\n') + '\n\n' + moves;
      })
      .join('\n\n\n');
  }

  async remove(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (analysis.userId !== userId) throw new ForbiddenException();
    await this.prisma.analysis.delete({ where: { id } });
    return { deleted: true };
  }
}
