import { triggerPveGeneration } from './trigger-pve-generation';

function makeLogger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

const ENV_OK = {
  AUTO_TRIGGER_PVE_GEN: 'true',
  ECS_CLUSTER: 'kingside',
  TACTIC_TASK_DEF_ARN:
    'arn:aws:ecs:eu-central-1:342946498289:task-definition/kingside-tactic-worker:15',
  ECS_SUBNETS: 'subnet-aaa,subnet-bbb',
  ECS_SECURITY_GROUPS: 'sg-xxx',
};

describe('triggerPveGeneration (KS-2775)', () => {
  it('feature-flag OFF → no-op, RunTask не вызывается', async () => {
    const logger = makeLogger();
    const ecsClient = {
      send: jest.fn(),
    };
    const factory = jest.fn().mockResolvedValue(ecsClient);
    const cmdFactory = jest.fn();

    const r = await triggerPveGeneration({
      importId: 'imp-1',
      logger,
      env: { ...ENV_OK, AUTO_TRIGGER_PVE_GEN: 'false' },
      ecsClientFactory: factory,
      runTaskCommandFactory: cmdFactory,
    });

    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('feature-flag-off');
    expect(factory).not.toHaveBeenCalled();
    expect(ecsClient.send).not.toHaveBeenCalled();
  });

  it('missing env → warn + no-op', async () => {
    const logger = makeLogger();
    const ecsClient = { send: jest.fn() };
    const r = await triggerPveGeneration({
      importId: 'imp-1',
      logger,
      env: { ...ENV_OK, ECS_CLUSTER: undefined },
      ecsClientFactory: jest.fn().mockResolvedValue(ecsClient),
      runTaskCommandFactory: jest.fn(),
    });

    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('missing-env');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ECS_CLUSTER=MISSING'),
    );
    expect(ecsClient.send).not.toHaveBeenCalled();
  });

  it('success-path: RunTask вызван с правильным command и taskArn в логе', async () => {
    const logger = makeLogger();
    const taskArn =
      'arn:aws:ecs:eu-central-1:342946498289:task/kingside/abc123';
    const ecsClient = {
      send: jest.fn().mockResolvedValue({ tasks: [{ taskArn }] }),
    };
    const cmdFactory = jest.fn().mockImplementation((input) => ({ __cmd: input }));

    const r = await triggerPveGeneration({
      importId: '5597fa39-1f6d-4308-8ade-9d1d6ad03c80',
      logger,
      env: ENV_OK,
      ecsClientFactory: jest.fn().mockResolvedValue(ecsClient),
      runTaskCommandFactory: cmdFactory,
    });

    expect(r.triggered).toBe(true);
    expect(r.taskArn).toBe(taskArn);

    // Проверка input'а команды.
    expect(cmdFactory).toHaveBeenCalledTimes(1);
    const input = cmdFactory.mock.calls[0][0] as {
      cluster: string;
      taskDefinition: string;
      launchType: string;
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: string[];
          securityGroups: string[];
          assignPublicIp: string;
        };
      };
      overrides: {
        containerOverrides: Array<{ name: string; command: string[] }>;
      };
    };
    expect(input.cluster).toBe('kingside');
    expect(input.taskDefinition).toBe(ENV_OK.TACTIC_TASK_DEF_ARN);
    expect(input.launchType).toBe('FARGATE');
    expect(input.networkConfiguration.awsvpcConfiguration.subnets).toEqual([
      'subnet-aaa',
      'subnet-bbb',
    ]);
    expect(input.networkConfiguration.awsvpcConfiguration.securityGroups).toEqual([
      'sg-xxx',
    ]);
    expect(input.overrides.containerOverrides[0].name).toBe('tactic-worker');
    expect(input.overrides.containerOverrides[0].command).toEqual([
      'node',
      'dist/main.js',
      'generate-puzzles',
      '--solution-mode=play-vs-engine',
      '--import-id=5597fa39-1f6d-4308-8ade-9d1d6ad03c80',
      '--exclude-used',
      '--min-rating=2400',
      '--max-games=inf',
      '--time-ms=1000',
      '--half-moves-n=6',
    ]);

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('triggered tactic-worker run-task='),
    );
  });

  it('RunTask вернул пустой tasks[] → no-task-returned, warn, импорт не падает', async () => {
    const logger = makeLogger();
    const ecsClient = {
      send: jest.fn().mockResolvedValue({ tasks: [] }),
    };
    const r = await triggerPveGeneration({
      importId: 'imp-2',
      logger,
      env: ENV_OK,
      ecsClientFactory: jest.fn().mockResolvedValue(ecsClient),
      runTaskCommandFactory: jest.fn().mockImplementation((i) => i),
    });

    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('no-task-returned');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('RunTask returned no tasks'),
    );
  });

  it('RunTask бросает → run-task-failed, warn, импорт не падает', async () => {
    const logger = makeLogger();
    const ecsClient = {
      send: jest.fn().mockRejectedValue(new Error('AccessDeniedException')),
    };
    const r = await triggerPveGeneration({
      importId: 'imp-3',
      logger,
      env: ENV_OK,
      ecsClientFactory: jest.fn().mockResolvedValue(ecsClient),
      runTaskCommandFactory: jest.fn().mockImplementation((i) => i),
    });

    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('run-task-failed');
    expect(r.error).toContain('AccessDenied');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('RunTask failed'),
    );
  });

  it('SDK load fail → sdk-load-failed (когда factory бросает)', async () => {
    const logger = makeLogger();
    const r = await triggerPveGeneration({
      importId: 'imp-4',
      logger,
      env: ENV_OK,
      ecsClientFactory: jest
        .fn()
        .mockRejectedValue(new Error('module not found')),
      runTaskCommandFactory: jest.fn(),
    });

    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('sdk-load-failed');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS-SDK load failed'),
    );
  });

  // ─── KS-3396: горизонтальный шардинг ──────────────────────────────

  it('PVE_SHARD_COUNT=3 → 3 RunTask с --shard=0/3,1/3,2/3', async () => {
    const logger = makeLogger();
    let n = 0;
    const ecsClient = {
      send: jest.fn().mockImplementation(async () => ({
        tasks: [{ taskArn: `arn:task/shard-${n++}` }],
      })),
    };
    const cmdFactory = jest.fn().mockImplementation((input) => ({ __cmd: input }));

    const r = await triggerPveGeneration({
      importId: 'imp-shard',
      logger,
      env: { ...ENV_OK, PVE_SHARD_COUNT: '3' },
      ecsClientFactory: jest.fn().mockResolvedValue(ecsClient),
      runTaskCommandFactory: cmdFactory,
    });

    expect(r.triggered).toBe(true);
    expect(r.shardCount).toBe(3);
    expect(r.taskArns).toHaveLength(3);
    expect(r.reason).toBeUndefined();
    expect(cmdFactory).toHaveBeenCalledTimes(3);

    // Каждый RunTask несёт корректный --shard=i/3.
    const shardFlags = cmdFactory.mock.calls.map((c) => {
      const input = c[0] as {
        overrides: { containerOverrides: Array<{ command: string[] }> };
      };
      return input.overrides.containerOverrides[0].command.find((a) =>
        a.startsWith('--shard='),
      );
    });
    expect(shardFlags).toEqual(['--shard=0/3', '--shard=1/3', '--shard=2/3']);
  });

  it('PVE_SHARD_COUNT=1 (default) → один RunTask без --shard', async () => {
    const logger = makeLogger();
    const ecsClient = {
      send: jest.fn().mockResolvedValue({ tasks: [{ taskArn: 'arn:task/solo' }] }),
    };
    const cmdFactory = jest.fn().mockImplementation((input) => ({ __cmd: input }));

    const r = await triggerPveGeneration({
      importId: 'imp-solo',
      logger,
      env: { ...ENV_OK, PVE_SHARD_COUNT: '1' },
      ecsClientFactory: jest.fn().mockResolvedValue(ecsClient),
      runTaskCommandFactory: cmdFactory,
    });

    expect(r.triggered).toBe(true);
    expect(cmdFactory).toHaveBeenCalledTimes(1);
    const input = cmdFactory.mock.calls[0][0] as {
      overrides: { containerOverrides: Array<{ command: string[] }> };
    };
    const cmd = input.overrides.containerOverrides[0].command;
    expect(cmd.some((a) => a.startsWith('--shard='))).toBe(false);
  });

  it('частичный успех: один шард упал → triggered=true, reason=partial, taskArns только успешные', async () => {
    const logger = makeLogger();
    let call = 0;
    const ecsClient = {
      send: jest.fn().mockImplementation(async () => {
        call++;
        if (call === 2) throw new Error('ThrottlingException');
        return { tasks: [{ taskArn: `arn:task/ok-${call}` }] };
      }),
    };
    const r = await triggerPveGeneration({
      importId: 'imp-partial',
      logger,
      env: { ...ENV_OK, PVE_SHARD_COUNT: '3' },
      ecsClientFactory: jest.fn().mockResolvedValue(ecsClient),
      runTaskCommandFactory: jest.fn().mockImplementation((i) => i),
    });

    expect(r.triggered).toBe(true);
    expect(r.reason).toBe('partial');
    expect(r.taskArns).toHaveLength(2); // 1-й и 3-й успешны, 2-й упал
    expect(r.error).toContain('Throttling');
  });

  it('все шарды упали → triggered=false, run-task-failed', async () => {
    const logger = makeLogger();
    const ecsClient = {
      send: jest.fn().mockRejectedValue(new Error('AccessDenied')),
    };
    const r = await triggerPveGeneration({
      importId: 'imp-allfail',
      logger,
      env: { ...ENV_OK, PVE_SHARD_COUNT: '2' },
      ecsClientFactory: jest.fn().mockResolvedValue(ecsClient),
      runTaskCommandFactory: jest.fn().mockImplementation((i) => i),
    });

    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('run-task-failed');
    expect(r.shardCount).toBe(2);
  });
});
