import { Global, Module } from '@nestjs/common';
import { StockfishService } from './stockfish.service';

/**
 * KS-2431. Глобальный модуль StockfishService для tactic-worker.
 *
 * @Global() — чтобы CLI-обработчики (puzzle-generator, sf-validator)
 * могли запросить сервис из любого места без явных imports в их
 * sub-модулях.
 */
@Global()
@Module({
  providers: [StockfishService],
  exports: [StockfishService],
})
export class StockfishModule {}
