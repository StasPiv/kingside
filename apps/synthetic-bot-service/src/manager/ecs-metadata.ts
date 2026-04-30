/**
 * Чтение TASK_ID из ECS metadata (ADR-034-v2 §3.3, §10.2). Идентификатор
 * нужен для:
 *   - шардирования пула ботов между task'ами (`stableHash(TASK_ID) % N`);
 *   - значения Redis-локов `synth:active:<botId>` = `<taskId>` (graceful
 *     shutdown проверяет owner'а перед DEL);
 *   - heartbeat-ключа `synth:task:<taskId>:active`.
 *
 * Локально (без ECS — `ECS_CONTAINER_METADATA_URI_V4` не задан) возвращаем
 * `local-<pid>`. Это допустимо в dev/test: PID уникален в пределах хоста и
 * меняется при перезапуске, что эмулирует поведение ECS task'а.
 *
 * Сетевые ошибки запроса к metadata-endpoint'у не должны валить старт
 * сервиса — fallback на `local-<pid>` с warn-логом.
 */
export type FetchLike = (
  input: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const METADATA_TIMEOUT_MS = 1500;

export async function resolveTaskId(
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  envOverride?: NodeJS.ProcessEnv,
): Promise<string> {
  const env = envOverride ?? process.env;
  const metadataUri = env.ECS_CONTAINER_METADATA_URI_V4;
  if (!metadataUri) {
    return localTaskId();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${metadataUri}/task`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ecs-metadata] /task returned ${response.status}, falling back to local`,
      );
      return localTaskId();
    }
    const body = (await response.json()) as { TaskARN?: string } | undefined;
    if (!body || typeof body.TaskARN !== 'string' || body.TaskARN.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        '[ecs-metadata] /task missing TaskARN, falling back to local',
      );
      return localTaskId();
    }
    return body.TaskARN;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ecs-metadata] /task failed: ${(err as Error).message}, falling back to local`,
    );
    return localTaskId();
  } finally {
    clearTimeout(timer);
  }
}

function localTaskId(): string {
  return `local-${process.pid}`;
}
