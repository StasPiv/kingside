import { ARCHIVE_PLY_LIMIT } from '@kingside/shared';
import { PLY_LIMIT } from './position-indexer.service';
import { POSITION_PLY_LIMIT } from './position-row-builder';

/**
 * Инвариант #2 (ply-lock) из ADR-016: оба архивных индекса
 * (`position_stats` и `archive_game_positions`) должны использовать один
 * и тот же лимит ply — иначе дерево ходов показывает партию на позиции,
 * которой нет в списке партий этой же позиции (и наоборот).
 *
 * Этот тест — единственный, кто закрепляет равенство констант на уровне
 * кода; если кто-то захочет поднять лимит для одного из индексов, тест
 * упадёт и заставит править оба.
 */
describe('ADR-016 ply-lock invariant', () => {
  it('PLY_LIMIT (position_stats) === POSITION_PLY_LIMIT (archive_game_positions)', () => {
    expect(PLY_LIMIT).toBe(POSITION_PLY_LIMIT);
  });

  it('обе константы равны ARCHIVE_PLY_LIMIT из @kingside/shared', () => {
    expect(PLY_LIMIT).toBe(ARCHIVE_PLY_LIMIT);
    expect(POSITION_PLY_LIMIT).toBe(ARCHIVE_PLY_LIMIT);
  });

  it('ARCHIVE_PLY_LIMIT = 40 (значение зафиксировано задачей KS-1632)', () => {
    expect(ARCHIVE_PLY_LIMIT).toBe(40);
  });
});
