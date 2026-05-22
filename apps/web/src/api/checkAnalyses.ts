import { api } from '../api';

/**
 * KS-3261: batch-проверка существования пользовательских analyses
 * по source-game идентификаторам. Используется для бейджа «В мастерской»
 * в списках карточек (BroadcastRoundPage, ArchiveGamesList и т.п.).
 *
 * Backend (commit 1b18d16f): `POST /analyses/check
 * {lichessGameIds?: string[], archiveGameIds?: string[]}` →
 * `{lichess: {id→analysisId|null}, archive: {id→analysisId|null}}`.
 *
 * Backend клампит каждый массив до 200; ничего fancy с пагинацией не
 * делаем — если у пользователя на странице >200 карточек, делим на
 * пачки по 200 на клиенте.
 */

export interface CheckAnalysesRequest {
  lichessGameIds?: string[];
  archiveGameIds?: string[];
}

export interface CheckAnalysesResponse {
  lichess: Record<string, string | null>;
  archive: Record<string, string | null>;
}

const MAX_BATCH = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Возвращает merged map для всех id'шников из обоих списков. null для
 * id, по которым у юзера нет analysis. Если auth отсутствует — возвращает
 * пустые объекты (бейджи просто не покажутся).
 */
export async function checkAnalyses(
  req: CheckAnalysesRequest,
): Promise<CheckAnalysesResponse> {
  const lichess: string[] = req.lichessGameIds ?? [];
  const archive: string[] = req.archiveGameIds ?? [];
  if (lichess.length === 0 && archive.length === 0) {
    return { lichess: {}, archive: {} };
  }
  const lBatches = chunk(lichess, MAX_BATCH);
  const aBatches = chunk(archive, MAX_BATCH);
  // Сводим к равному количеству батчей; если один из списков короче —
  // пустой массив подмешиваем во второй.
  const maxLen = Math.max(lBatches.length, aBatches.length, 1);
  const acc: CheckAnalysesResponse = { lichess: {}, archive: {} };
  for (let i = 0; i < maxLen; i++) {
    const body: CheckAnalysesRequest = {};
    if (lBatches[i]) body.lichessGameIds = lBatches[i];
    if (aBatches[i]) body.archiveGameIds = aBatches[i];
    try {
      const part = await api.post<CheckAnalysesResponse>(
        '/analyses/check',
        body,
      );
      Object.assign(acc.lichess, part.lichess ?? {});
      Object.assign(acc.archive, part.archive ?? {});
    } catch {
      // Ошибка одной пачки не должна валить весь UI бейджей.
      // Отсутствующие записи останутся undefined → бейдж не покажется.
    }
  }
  return acc;
}
