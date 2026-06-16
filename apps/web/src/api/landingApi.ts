import { api } from '../api';

/**
 * KS-4267 / ADR-129 §6.5, §10.1. DTO публичного эндпоинта
 * `GET /landing/stats` (KS-4264). Backend кэширует ответ в Redis
 * (TTL 60s) и ограничивает rate-limit 60/мин для IP. Использует
 * блок «Proof» на гостевом лендинге.
 *
 * Тип объявлен локально (не в `packages/shared`) — frontend для
 * этой задачи только читает данные, контракт зафиксирован
 * в KS-4264; если он расширится — перенесём в shared.
 */
export interface LandingStats {
  totalGames: number;
  totalPuzzlesSolved: number;
  registeredUsers: number;
  onlineNow: number;
  gamesInProgress: number;
}

export const landingApi = {
  /**
   * Возвращает агрегированную статистику платформы для блока
   * «Proof» на гостевом лендинге. При 5xx/таймауте/сетевой ошибке
   * вызывающий компонент НЕ должен рендерить блок (см. §5.4 ADR-129).
   */
  getStats(signal?: AbortSignal): Promise<LandingStats> {
    return api.get<LandingStats>('/landing/stats', signal ? { signal } : undefined);
  },
};
