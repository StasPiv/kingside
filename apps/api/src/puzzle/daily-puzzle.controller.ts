import { Controller, Get, Query } from '@nestjs/common';
import { DailyPuzzleService } from './daily-puzzle.service';

@Controller('puzzles/daily')
export class DailyPuzzleController {
  constructor(private readonly dailyPuzzleService: DailyPuzzleService) {}

  @Get()
  getDailyPuzzle(@Query('date') dateStr?: string) {
    const date = dateStr ? new Date(dateStr) : undefined;
    if (dateStr && isNaN(date!.getTime())) {
      return { error: 'Invalid date format' };
    }
    return this.dailyPuzzleService.getDailyPuzzle(date);
  }
}
