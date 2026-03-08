import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PuzzleService } from './puzzle.service';
import { FindPuzzlesDto } from './dto/puzzle.dto';

@Controller('puzzles')
export class PuzzleController {
  constructor(private readonly puzzleService: PuzzleService) {}

  /**
   * GET /puzzles — поиск задач по теме и сложности.
   * Query params: themes[]=fork&themes[]=pin&ratingMin=1200&ratingMax=1600&limit=10
   */
  @Get()
  findPuzzles(@Query() dto: FindPuzzlesDto) {
    return this.puzzleService.findPuzzles({
      themes: dto.themes,
      ratingMin: dto.ratingMin,
      ratingMax: dto.ratingMax,
      limit: dto.limit,
    });
  }

  /**
   * GET /puzzles/next — подобрать задачу для авторизованного пользователя
   * на основе его рейтинга, исключая решённые.
   */
  @UseGuards(JwtAuthGuard)
  @Get('next')
  async getNextPuzzle(@Request() req: any) {
    const puzzle = await this.puzzleService.findPuzzleForUser(req.user.id);
    if (!puzzle) {
      throw new NotFoundException('No puzzles available');
    }
    return puzzle;
  }

  /**
   * GET /puzzles/next/:theme — подобрать задачу по конкретной теме
   * для авторизованного пользователя.
   */
  @UseGuards(JwtAuthGuard)
  @Get('next/:theme')
  async getNextPuzzleByTheme(
    @Request() req: any,
    @Param('theme') theme: string,
  ) {
    const puzzle = await this.puzzleService.findPuzzleByThemeForUser(
      req.user.id,
      theme,
    );
    if (!puzzle) {
      throw new NotFoundException('No puzzles available for this theme');
    }
    return puzzle;
  }

  /**
   * GET /puzzles/:id — получить конкретную задачу по ID.
   */
  @Get(':id')
  async getPuzzle(@Param('id', ParseUUIDPipe) id: string) {
    const puzzle = await this.puzzleService.getPuzzleById(id);
    if (!puzzle) {
      throw new NotFoundException('Puzzle not found');
    }
    return puzzle;
  }
}
