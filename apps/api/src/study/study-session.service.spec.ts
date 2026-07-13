import { StudySessionService } from './study-session.service';

/**
 * KS-4933. Unit-тесты getCurrent: при нескольких слотах тренировки
 * реконсилятся ВСЕ активные сессии горизонта (не только самая свежая),
 * и пройденное занятие видно как completed сразу, не дожидаясь
 * 15-минутного cron. Prisma и tracking — ручные моки.
 */

const NOW = Date.now();
const HOUR = 3600_000;

interface Row {
  id: string;
  scheduleId: string;
  userId: string;
  scheduledAt: Date;
  status: string;
  completedAt: Date | null;
  score: number | null;
  lessonId: string | null;
  schedule: { name: string };
  tasks: Array<{
    id: string;
    position: number;
    type: string;
    params: unknown;
    targetCount: number;
    doneCount: number;
    status: string;
    role: string;
  }>;
}

function row(over: Partial<Row>): Row {
  return {
    id: 'sess-1',
    scheduleId: 'sch-1',
    userId: 'user-1',
    scheduledAt: new Date(NOW - HOUR),
    status: 'notified',
    completedAt: null,
    score: null,
    lessonId: null,
    schedule: { name: 'Тактика' },
    tasks: [],
    ...over,
  };
}

/** findMany-мок: сортирует по scheduledAt desc, как реальный запрос. */
function makePrisma(rowsByCall: Row[][]) {
  let call = 0;
  return {
    studySession: {
      findMany: jest.fn().mockImplementation(() => {
        const rows = rowsByCall[Math.min(call, rowsByCall.length - 1)];
        call++;
        return Promise.resolve(
          [...rows].sort(
            (a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime(),
          ),
        );
      }),
    },
  };
}

describe('StudySessionService.getCurrent (KS-4933)', () => {
  it('реконсилит все активные сессии, completed виден сразу при будущем втором слоте', async () => {
    const past = row({
      id: 'sess-past',
      scheduledAt: new Date(NOW - HOUR),
      status: 'in_progress',
    });
    const future = row({
      id: 'sess-future',
      scheduledAt: new Date(NOW + 20 * HOUR),
      status: 'planned',
    });
    // После reconcile прошедшая сессия завершена.
    const pastCompleted = {
      ...past,
      status: 'completed',
      completedAt: new Date(NOW),
      score: 90,
    };
    const prisma = makePrisma([
      [past, future],
      [pastCompleted, future],
    ]);
    const tracking = { reconcileById: jest.fn().mockResolvedValue(undefined) };
    const svc = new StudySessionService(prisma as never, tracking as never);

    const sessions = await svc.getCurrent('user-1');

    // Обе активные сессии реконсилированы — не только самая свежая.
    expect(tracking.reconcileById).toHaveBeenCalledTimes(2);
    expect(tracking.reconcileById).toHaveBeenCalledWith('sess-past');
    expect(tracking.reconcileById).toHaveBeenCalledWith('sess-future');
    // Текущая для тренировки — наступившая completed, не будущая planned.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-past');
    expect(sessions[0].status).toBe('completed');
    expect(sessions[0].score).toBe(90);
  });

  it('без наступивших сессий — ближайшая будущая', async () => {
    const near = row({
      id: 'sess-near',
      scheduledAt: new Date(NOW + 5 * HOUR),
      status: 'planned',
    });
    const far = row({
      id: 'sess-far',
      scheduledAt: new Date(NOW + 22 * HOUR),
      status: 'planned',
    });
    const prisma = makePrisma([[near, far]]);
    const tracking = { reconcileById: jest.fn().mockResolvedValue(undefined) };
    const svc = new StudySessionService(prisma as never, tracking as never);

    const sessions = await svc.getCurrent('user-1');

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-near');
  });

  it('разные тренировки — по одной сессии на каждую', async () => {
    const a = row({
      id: 'a1',
      scheduleId: 'sch-a',
      scheduledAt: new Date(NOW - HOUR),
      status: 'completed',
      completedAt: new Date(NOW - HOUR / 2),
      schedule: { name: 'A' },
    });
    const b = row({
      id: 'b1',
      scheduleId: 'sch-b',
      scheduledAt: new Date(NOW + 10 * HOUR),
      status: 'planned',
      schedule: { name: 'B' },
    });
    const prisma = makePrisma([[a, b]]);
    const tracking = { reconcileById: jest.fn().mockResolvedValue(undefined) };
    const svc = new StudySessionService(prisma as never, tracking as never);

    const sessions = await svc.getCurrent('user-1');

    // completed не активна — reconcile только для planned b1.
    expect(tracking.reconcileById).toHaveBeenCalledTimes(1);
    expect(tracking.reconcileById).toHaveBeenCalledWith('b1');
    expect(sessions.map((s) => s.id).sort()).toEqual(['a1', 'b1']);
  });

  it('нет активных сессий — второй findMany не выполняется', async () => {
    const done = row({
      id: 'd1',
      status: 'completed',
      completedAt: new Date(NOW),
    });
    const prisma = makePrisma([[done]]);
    const tracking = { reconcileById: jest.fn() };
    const svc = new StudySessionService(prisma as never, tracking as never);

    await svc.getCurrent('user-1');

    expect(tracking.reconcileById).not.toHaveBeenCalled();
    expect(prisma.studySession.findMany).toHaveBeenCalledTimes(1);
  });
});
