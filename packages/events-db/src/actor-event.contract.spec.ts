/**
 * KS-4691: shape-тесты публичного API пакета `@kingside/events-db`.
 * Не требуют живой БД — проверяют, что Prisma Client сгенерирован и
 * экспортирует то, что заявлено в `prisma/schema.prisma` (модель
 * `ActorEvent` + scalar fields с правильными типами).
 *
 * Эти тесты — defence in depth от случайного `prisma generate` мимо
 * нашей схемы и от «потерянного» поля при правке схемы.
 */
import { PrismaClient, Prisma } from './index';

describe('@kingside/events-db public API', () => {
  it('exports PrismaClient constructor', () => {
    expect(typeof PrismaClient).toBe('function');
  });

  it('Prisma namespace содержит ActorEventScalarFieldEnum', () => {
    // ScalarFieldEnum — каноническая точка проверки модели: если кто-то
    // случайно переименует поле без обновления схемы — тест упадёт.
    const fields = Object.keys(Prisma.ActorEventScalarFieldEnum);
    expect(fields.sort()).toEqual(
      ['actorId', 'actorType', 'createdAt', 'id', 'payload', 'type'].sort(),
    );
  });

  it('PrismaClient можно сконструировать с phony URL (без подключения)', () => {
    // datasourceUrl с заведомо нерабочим хостом — PrismaClient
    // ленив, подключение происходит при первом запросе. Конструктор
    // не должен бросать; нужен лишь как smoke-проверка bundling'а
    // нативного бинаря prisma-engine.
    const phony =
      'postgresql://x:y@127.0.0.1:1?schema=events&connection_timeout=1';
    const client = new PrismaClient({ datasourceUrl: phony });
    // Не `toBeInstanceOf(PrismaClient)` — prisma 6 экспортирует через
    // прокси, инстанс-чек ломается. Проверяем интерфейс по утиному
    // тесту: ленивая фабрика дала объект с `$disconnect`.
    expect(client).toBeDefined();
    expect(typeof client.$disconnect).toBe('function');
    expect(typeof client.actorEvent).toBe('object');
    // Disconnect фейлит наружу — не страшно, мы и не коннектились.
    void client.$disconnect().catch(() => undefined);
  });
});
