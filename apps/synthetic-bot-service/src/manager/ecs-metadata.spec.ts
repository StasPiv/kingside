import { resolveTaskId, type FetchLike } from './ecs-metadata';

function fetchStub(
  result:
    | { ok: boolean; status: number; body: unknown }
    | { throwError: Error },
): FetchLike & { calls: number } {
  const fn = ((async () => {
    fn.calls++;
    if ('throwError' in result) throw result.throwError;
    return {
      ok: result.ok,
      status: result.status,
      async json() {
        return result.body;
      },
    };
  }) as unknown) as FetchLike & { calls: number };
  fn.calls = 0;
  return fn;
}

describe('resolveTaskId', () => {
  it('local-<pid> при отсутствии ECS_CONTAINER_METADATA_URI_V4', async () => {
    const id = await resolveTaskId(
      fetchStub({ ok: true, status: 200, body: {} }),
      {} as NodeJS.ProcessEnv,
    );
    expect(id).toBe(`local-${process.pid}`);
  });

  it('возвращает TaskARN из metadata', async () => {
    const arn = 'arn:aws:ecs:eu-central-1:42:task/cluster/abc-123';
    const id = await resolveTaskId(
      fetchStub({ ok: true, status: 200, body: { TaskARN: arn } }),
      { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/abc' } as NodeJS.ProcessEnv,
    );
    expect(id).toBe(arn);
  });

  it('fallback на local-<pid> при HTTP-ошибке', async () => {
    const id = await resolveTaskId(
      fetchStub({ throwError: new Error('ECONNREFUSED') }),
      { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/abc' } as NodeJS.ProcessEnv,
    );
    expect(id).toBe(`local-${process.pid}`);
  });

  it('fallback при не-2xx', async () => {
    const id = await resolveTaskId(
      fetchStub({ ok: false, status: 500, body: '' }),
      { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/abc' } as NodeJS.ProcessEnv,
    );
    expect(id).toBe(`local-${process.pid}`);
  });

  it('fallback при отсутствующем TaskARN', async () => {
    const id = await resolveTaskId(
      fetchStub({ ok: true, status: 200, body: { foo: 'bar' } }),
      { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/abc' } as NodeJS.ProcessEnv,
    );
    expect(id).toBe(`local-${process.pid}`);
  });
});
