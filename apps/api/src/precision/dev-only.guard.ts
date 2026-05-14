/**
 * KS-3029. Guard для dev-only endpoint'ов: пускает запрос, если
 * `NODE_ENV !== 'production'`. На проде — 404 (NotFoundException,
 * чтобы endpoint выглядел как несуществующий, без подсказок о
 * наличии скрытой функциональности).
 *
 * Используется для `POST /precision/attempts/_test_fixture` (KS-3029),
 * который позволяет фронту создавать precision-attempt с произвольными
 * WDL/cp без chess.js валидации — для e2e KS-3007 (5★ сценарии).
 *
 * Паттерн: `process.env.NODE_ENV === 'production'` первичен (так же
 * как в `AuthService.devBypass`, см. KS-2254). На stage / dev допускается
 * без дополнительного секрета — endpoint выгружен только в этих
 * окружениях, отдельный header не требуется.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DevOnlyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(_ctx: ExecutionContext): boolean {
    const nodeEnv =
      this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
    if (nodeEnv === 'production') {
      // 404 вместо 403 — чтобы endpoint выглядел несуществующим.
      throw new NotFoundException();
    }
    return true;
  }
}
