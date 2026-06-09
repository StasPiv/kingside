import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  LECTURE_CHAT_LIMITS,
  type LectureChatMessage as LectureChatMessageDto,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * KS-4008 / ADR-121 Phase 1 §6, §7.
 *
 * Бизнес-логика чата лекции:
 *   - валидация и нормализация текста (trim, длина, control-char);
 *   - rate-limit через Redis sliding window
 *     (`chat-rl:{lectureId}:{userId}`, 3 сообщения / 10 сек);
 *   - duplicate guard через `GET/SET chat-last:{lectureId}:{userId}`
 *     (TTL 30 сек) — хеш последнего сообщения, чтобы не пропустить два
 *     подряд одинаковых;
 *   - mute-check (`LectureChatMute`);
 *   - persist в `LectureChatMessage`;
 *   - snapshot для подключающихся клиентов (последние N=100).
 *
 * Сервис НЕ занимается WS-broadcast'ом — это работа `LiveAnalysisGateway`.
 * Сервис возвращает либо успешно созданное сообщение, либо typed-ошибку
 * `ChatValidationError` с кодом из `LectureChatErrorCode` — gateway
 * мапит её в `chat:error` событие отправителю.
 *
 * Тренер (owner лекции) — особый случай:
 *   - rate-limit и duplicate guard НЕ применяются (см. §6.3 ADR-121);
 *   - mute-check тоже не применяется (тренер сам себя не мьютит);
 *   - `isTrainerMessage=true` сохраняется в БД (денормализация).
 */

/**
 * Коды ошибок (зеркало `LectureChatErrorCode` из @kingside/shared).
 * Локально объявляем union, чтобы избежать циркулярного импорта типа в
 * runtime; gateway мапит каждый случай в `chat:error`.
 */
export type ChatErrorCode =
  | 'rate_limited'
  | 'too_long'
  | 'too_short'
  | 'duplicate'
  | 'muted'
  | 'forbidden'
  | 'closed'
  | 'invalid_payload'
  | 'not_found'
  | 'control_char';

export class ChatValidationError extends Error {
  constructor(public readonly code: ChatErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ChatValidationError';
  }
}

@Injectable()
export class LectureChatService {
  private readonly logger = new Logger(LectureChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Нормализация и валидация текста сообщения.
   *   - trim;
   *   - длина в unicode-codepoints (Array.from учитывает суррогатные
   *     пары: один emoji = 1 codepoint, а не 2);
   *   - запрет ASCII control-chars (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F,
   *     0x7F). \n (0x0A) и \r (0x0D) — разрешены (многострочный ввод).
   *   - бросает `ChatValidationError` с конкретным кодом.
   */
  normalizeText(raw: string): string {
    const trimmed = (raw ?? '').trim();
    const codePoints = Array.from(trimmed);
    if (codePoints.length === 0) {
      throw new ChatValidationError('too_short', 'Message is empty');
    }
    if (codePoints.length > LECTURE_CHAT_LIMITS.MAX_TEXT_LENGTH) {
      throw new ChatValidationError(
        'too_long',
        `Message exceeds ${LECTURE_CHAT_LIMITS.MAX_TEXT_LENGTH} characters`,
      );
    }
    // \n=0x0A, \r=0x0D, \t=0x09 — оставляем (нормальный текст);
    // остальные control-chars запрещаем.
    for (const ch of trimmed) {
      const code = ch.charCodeAt(0);
      if (
        (code <= 0x08) ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f
      ) {
        throw new ChatValidationError(
          'control_char',
          'Message contains forbidden control characters',
        );
      }
    }
    return trimmed;
  }

  /**
   * Проверка mute. Owner-тренер не мьютится (по контракту gateway не
   * вызывает эту проверку для owner'а, но дублируем guard на случай
   * багов: ownerId никогда не должен попасть в LectureChatMute, потому
   * что mute-handler отказывает на self-mute).
   */
  async isMuted(lectureId: string, userId: string): Promise<boolean> {
    const mute = await this.prisma.lectureChatMute.findUnique({
      where: { lectureId_userId: { lectureId, userId } },
      select: { id: true },
    });
    return mute !== null;
  }

  /**
   * Sliding-window rate-limit через Sorted Set'ы Redis:
   *   ZREMRANGEBYSCORE key 0 (now - WINDOW_MS)
   *   ZCARD key  → текущее число событий в окне
   *   ZADD key now <unique>
   *   EXPIRE key WINDOW_MS/1000
   *
   * Возвращает true если запись прошла (лимит ещё не превышен).
   * Если ZCARD после очистки >= LIMIT — НЕ добавляем точку и
   * возвращаем false (отказ).
   *
   * Уникальный member использует `now-<rand>` чтобы избежать коллизий
   * при двух запросах в одну миллисекунду.
   */
  async checkAndConsumeRateLimit(
    lectureId: string,
    userId: string,
  ): Promise<boolean> {
    const key = `chat-rl:${lectureId}:${userId}`;
    const now = Date.now();
    const windowStart = now - LECTURE_CHAT_LIMITS.RATE_LIMIT_WINDOW_MS;
    // Pipeline: outdated drop + count.
    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zcard(key);
    const results = await pipeline.exec();
    if (!results) {
      // Redis вернул null — считаем что отказ безопаснее, чем тихий
      // обход лимита (но логируем как warn — это инфра).
      this.logger.warn(
        `rate-limit pipeline returned null lecture=${lectureId} user=${userId}`,
      );
      return false;
    }
    const count = (results[1]?.[1] as number) ?? 0;
    if (count >= LECTURE_CHAT_LIMITS.RATE_LIMIT_WINDOW_COUNT) {
      return false;
    }
    const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    const ttlSec = Math.ceil(
      LECTURE_CHAT_LIMITS.RATE_LIMIT_WINDOW_MS / 1000,
    );
    await this.redis
      .multi()
      .zadd(key, now, member)
      .expire(key, ttlSec)
      .exec();
    return true;
  }

  /**
   * Duplicate guard: SHA-1 хеш текста сравнивается с последним
   * сохранённым для пары (lecture, user). Если совпал — отказ.
   * Иначе перезаписываем с TTL 30 сек (см. LECTURE_CHAT_LIMITS).
   *
   * SHA-1 достаточно для anti-spam: коллизии в коротких текстах
   * практически невозможны, скорость — копейки.
   */
  async checkAndConsumeDuplicate(
    lectureId: string,
    userId: string,
    text: string,
  ): Promise<boolean> {
    const key = `chat-last:${lectureId}:${userId}`;
    const hash = createHash('sha1').update(text).digest('hex');
    const prev = await this.redis.get(key);
    if (prev === hash) {
      return false;
    }
    await this.redis.set(
      key,
      hash,
      'EX',
      LECTURE_CHAT_LIMITS.DUPLICATE_TTL_SEC,
    );
    return true;
  }

  /**
   * Сохранить сообщение и вернуть payload `chat:message` для broadcast'а.
   * Не делает WS-emit'ов — это работа gateway'а.
   *
   * Аргументы:
   *   - `lectureId` — UUID лекции;
   *   - `ownerId` — owner лекции (для денормализации isTrainerMessage);
   *   - `authorId` — кто шлёт (null НЕ допускается в Phase 1 — гейтвей
   *     блокирует анонимов раньше).
   *   - `text` — уже нормализованный (через normalizeText).
   *   - `authorUsername` — для шапки сообщения у клиента (берём из
   *     `User.username` на стороне gateway, без отдельного join'а).
   */
  async persistMessage(args: {
    lectureId: string;
    ownerId: string;
    authorId: string;
    authorUsername: string | null;
    text: string;
  }): Promise<LectureChatMessageDto> {
    const isTrainerMessage = args.authorId === args.ownerId;
    const row = await this.prisma.lectureChatMessage.create({
      data: {
        lectureId: args.lectureId,
        authorId: args.authorId,
        text: args.text,
        isTrainerMessage,
        // kind по умолчанию 'user'; pinned=false; deletedAt=null.
      },
      select: {
        id: true,
        lectureId: true,
        authorId: true,
        text: true,
        createdAt: true,
        isTrainerMessage: true,
        pinned: true,
        deletedAt: true,
        kind: true,
      },
    });
    return {
      id: row.id,
      lectureId: row.lectureId,
      authorId: row.authorId,
      authorUsername: args.authorUsername,
      text: row.text,
      createdAt: row.createdAt.toISOString(),
      isTrainerMessage: row.isTrainerMessage,
      pinned: row.pinned,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      kind: row.kind,
    };
  }

  /**
   * Soft-delete: ставит deletedAt + deletedById. Запись остаётся в БД
   * для аудита; gateway раздаёт `chat:delete` подписчикам, фронт сам
   * заменяет содержимое на «[удалено]».
   *
   * Возвращает `true` если запись была изменена (раньше не была
   * удалена), `false` — если её нет или уже удалена.
   */
  async softDeleteMessage(args: {
    lectureId: string;
    messageId: string;
    deletedById: string;
  }): Promise<boolean> {
    const row = await this.prisma.lectureChatMessage.findUnique({
      where: { id: args.messageId },
      select: { id: true, lectureId: true, deletedAt: true },
    });
    if (!row || row.lectureId !== args.lectureId) return false;
    if (row.deletedAt) return false;
    await this.prisma.lectureChatMessage.update({
      where: { id: args.messageId },
      data: {
        deletedAt: new Date(),
        deletedById: args.deletedById,
      },
    });
    return true;
  }

  /**
   * Upsert мьюта ученика в текущей лекции. Idempotent: повторный mute
   * того же ученика не плодит дубль (UNIQUE по [lectureId,userId]).
   * Self-mute (тренер пытается мьютить сам себя) — отказывается на
   * уровне gateway'а до вызова.
   */
  async muteUser(args: {
    lectureId: string;
    userId: string;
    mutedById: string;
  }): Promise<void> {
    await this.prisma.lectureChatMute.upsert({
      where: {
        lectureId_userId: {
          lectureId: args.lectureId,
          userId: args.userId,
        },
      },
      create: {
        lectureId: args.lectureId,
        userId: args.userId,
        mutedById: args.mutedById,
      },
      // Update: обновляем mutedById/createdAt — это перевыдача мьюта
      // (если тренер сменился — теоретически возможно для совместных
      // лекций, Phase 2).
      update: { mutedById: args.mutedById, createdAt: new Date() },
    });
  }

  /**
   * Последние N сообщений лекции для `chat:snapshot`. Возвращает в
   * ХРОНОЛОГИЧЕСКОМ порядке (старые → новые), чтобы фронт мог
   * напрямую prepend'ить к ленте без reverse'а. Удалённые сохраняются
   * в списке, но с подменой текста на «[удалено]».
   *
   * `pinnedId` ищется отдельным запросом (одно pinned на лекцию по
   * контракту). Если pinned не входит в последние N — он всё равно
   * не отображается у фронта (Phase 1 без отдельной полосы pinned —
   * UI отдаст это в Phase 2; здесь `pinnedId` сохраняется как контракт).
   */
  async getSnapshotMessages(
    lectureId: string,
  ): Promise<LectureChatMessageDto[]> {
    const rows = await this.prisma.lectureChatMessage.findMany({
      where: { lectureId },
      orderBy: { createdAt: 'desc' },
      take: LECTURE_CHAT_LIMITS.SNAPSHOT_LIMIT,
      select: {
        id: true,
        lectureId: true,
        authorId: true,
        text: true,
        createdAt: true,
        isTrainerMessage: true,
        pinned: true,
        deletedAt: true,
        kind: true,
        author: { select: { username: true } },
      },
    });
    // reverse → хронологический порядок.
    return rows
      .slice()
      .reverse()
      .map((r) => ({
        id: r.id,
        lectureId: r.lectureId,
        authorId: r.authorId,
        authorUsername: r.author?.username ?? null,
        text: r.deletedAt ? '[удалено]' : r.text,
        createdAt: r.createdAt.toISOString(),
        isTrainerMessage: r.isTrainerMessage,
        pinned: r.pinned,
        deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
        kind: r.kind,
      }));
  }

  /**
   * UUID текущего pinned-сообщения лекции. MVP: одно pinned (контракт),
   * подтверждается LIMIT 1.
   */
  async getPinnedId(lectureId: string): Promise<string | null> {
    const row = await this.prisma.lectureChatMessage.findFirst({
      where: { lectureId, pinned: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }
}
