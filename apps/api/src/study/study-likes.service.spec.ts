/**
 * KS-2856 / KS-2859 B3. Тесты `StudyLikesService` — toggle, idempotency,
 * атомарный счётчик.
 */
import { StudyLikesService } from './study-likes.service';

function makePrisma() {
  const txContext: any = {
    studyLike: {
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    study: {
      update: jest.fn(),
    },
  };
  const prisma: any = {
    studyLike: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) =>
      cb(txContext),
    ),
  };
  return { prisma, tx: txContext };
}

const studyId = 's1';
const userId = 'u1';

describe('StudyLikesService — KS-2859 B3', () => {
  let prisma: any;
  let tx: any;
  let svc: StudyLikesService;

  beforeEach(() => {
    const made = makePrisma();
    prisma = made.prisma;
    tx = made.tx;
    svc = new StudyLikesService(prisma);
  });

  it('toggle: не было лайка → create + likes+1', async () => {
    tx.studyLike.findUnique.mockResolvedValue(null);
    tx.study.update.mockResolvedValue({ likes: 1 });
    const r = await svc.toggle(studyId, userId);
    expect(tx.studyLike.create).toHaveBeenCalledWith({
      data: { studyId, userId },
    });
    expect(tx.study.update).toHaveBeenCalledWith({
      where: { id: studyId },
      data: { likes: { increment: 1 } },
      select: { likes: true },
    });
    expect(r).toEqual({ liked: true, likes: 1 });
  });

  it('toggle: уже лайкал → delete + likes-1', async () => {
    tx.studyLike.findUnique.mockResolvedValue({ studyId, userId });
    tx.study.update.mockResolvedValue({ likes: 4 });
    const r = await svc.toggle(studyId, userId);
    expect(tx.studyLike.delete).toHaveBeenCalledWith({
      where: { studyId_userId: { studyId, userId } },
    });
    expect(tx.study.update).toHaveBeenCalledWith({
      where: { id: studyId },
      data: { likes: { decrement: 1 } },
      select: { likes: true },
    });
    expect(r).toEqual({ liked: false, likes: 4 });
  });

  it('toggle: лайки не уходят в минус (clamp 0)', async () => {
    tx.studyLike.findUnique.mockResolvedValue({ studyId, userId });
    tx.study.update.mockResolvedValue({ likes: -1 });
    const r = await svc.toggle(studyId, userId);
    expect(r.likes).toBe(0);
  });

  it('hasLiked: true если row есть', async () => {
    prisma.studyLike.findUnique.mockResolvedValue({ studyId });
    expect(await svc.hasLiked(studyId, userId)).toBe(true);
  });

  it('hasLiked: false если row нет', async () => {
    prisma.studyLike.findUnique.mockResolvedValue(null);
    expect(await svc.hasLiked(studyId, userId)).toBe(false);
  });
});
