import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAnalysisDto } from './dto/create-analysis.dto';
import { UpdateAnalysisDto } from './dto/update-analysis.dto';

@Injectable()
export class AnalysisService {
  constructor(private readonly prisma: PrismaService) {}

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
    const opening = this.extractOpening(dto.pgn);

    return this.prisma.analysis.create({
      data: {
        userId,
        title,
        pgn: dto.pgn ?? null,
        fen: dto.fen ?? null,
        opening,
      },
    });
  }

  async findAll(userId: string) {
    return this.prisma.analysis.findMany({
      where: { userId },
      select: {
        id: true,
        title: true,
        opening: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (analysis.userId !== userId) throw new ForbiddenException();
    return analysis;
  }

  async update(userId: string, id: string, dto: UpdateAnalysisDto) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (analysis.userId !== userId) throw new ForbiddenException();

    const opening =
      dto.pgn !== undefined
        ? this.extractOpening(dto.pgn)
        : analysis.opening;

    return this.prisma.analysis.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.pgn !== undefined && { pgn: dto.pgn }),
        ...(dto.fen !== undefined && { fen: dto.fen }),
        ...(dto.currentPosition !== undefined && { currentPosition: dto.currentPosition }),
        opening,
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
