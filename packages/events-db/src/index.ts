/**
 * KS-4691 / ADR-147 §2.3. Публичный API пакета `@kingside/events-db`.
 * По образцу `@kingside/archive-db` и `@kingside/broadcasts-db`:
 *
 *   import { PrismaClient as EventsPrismaClient } from '@kingside/events-db';
 *   const events = new EventsPrismaClient({
 *     datasourceUrl: process.env.EVENTS_DATABASE_URL,
 *   });
 *
 * Источник истины по подключению — env `EVENTS_DATABASE_URL`. URL
 * содержит `?schema=events`, пользователь — `events_writer`
 * (KS-4690 §3). Эти параметры — забота `apps/api` / EventsModule
 * (T1c, KS-4692), сам пакет про них ничего не знает.
 */
export { PrismaClient, Prisma } from './generated/prisma/client';
export * from './generated/prisma/models';
export * from './generated/prisma/enums';
