/**
 * KS-4750 / ADR-149 G4. Global-модуль EventsClient, чтобы инжектить
 * `EventsClientService` в game-сервисы без явного импорта модуля.
 *
 * Аналог `@Global() EventsModule` в apps/api: cross-cutting сервис,
 * нужен в game/matchmaking/turnir.
 */
import { Global, Module } from '@nestjs/common';
import { EventsClientService } from './events-client.service';

@Global()
@Module({
  providers: [EventsClientService],
  exports: [EventsClientService],
})
export class EventsClientModule {}
