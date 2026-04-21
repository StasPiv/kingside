/**
 * Хелперы для идемпотентной индексации (KS-1621).
 *
 * Проблема: `position_stats.total` — счётчик, `ON CONFLICT DO UPDATE SET
 * total = total + EXCLUDED.total` инкрементируется каждый раз. Если один
 * и тот же TWIC-пакет приезжает в indexer дважды (retry после сбоя,
 * ручной запуск, старый код без фильтрации), счётчик удваивается.
 *
 * Страховка — предварительно отбросить из обрабатываемого батча те
 * партии, чей `content_hash` уже есть в `archive_games`. Оставшиеся
 * передаются и в `archiveGame.create`, и в `PositionIndexer.index(...)`.
 * `create` внутри цикла дополнительно защищён catch'ем P2002 — от race'а
 * с параллельным запуском воркера.
 */

import type { ParsedGame } from './pgn-utils';

/** Минимальная форма Prisma, которой достаточно для `filterAlreadyImported`. */
export interface ArchiveGameHashLookup {
  findMany(args: {
    where: { contentHash: { in: Uint8Array<ArrayBuffer>[] } };
    select: { contentHash: true };
  }): Promise<Array<{ contentHash: Uint8Array | Buffer }>>;
}

/**
 * Возвращает подмножество партий из `games`, чьи `content_hash` ещё НЕ
 * сохранены в `archive_games`. Читает одним SELECT'ом: `WHERE contentHash
 * IN (...)`. На пустом входе делает 0 запросов.
 */
export async function filterAlreadyImported(
  prisma: { archiveGame: ArchiveGameHashLookup },
  games: ParsedGame[],
): Promise<ParsedGame[]> {
  if (games.length === 0) return [];

  // Prisma `Bytes` не принимает Buffer напрямую — копируем в чистый Uint8Array.
  const hashes: Uint8Array<ArrayBuffer>[] = games.map(toBytes);

  const existing = await prisma.archiveGame.findMany({
    where: { contentHash: { in: hashes } },
    select: { contentHash: true },
  });

  const known = new Set<string>(
    existing.map((r) => Buffer.from(r.contentHash).toString('hex')),
  );

  return games.filter((g) => !known.has(g.contentHash.toString('hex')));
}

/** `content_hash` в формате, принимаемом Prisma. */
export function toBytes(game: ParsedGame): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(game.contentHash.length));
  out.set(game.contentHash);
  return out;
}
