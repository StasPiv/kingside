import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * HTTP-interceptor для `broadcast_http_query_duration_seconds`.
 *
 * До KS-1710 histogram регистрировалась, но `.observe()` никто не вызывал —
 * за час трафика 0 семплов в /_/metrics. Теперь глобальный interceptor
 * (через APP_INTERCEPTOR в AppModule) меряет длительность HTTP-обработчиков
 * и записывает её по label `route`.
 *
 * Label `route` берётся из route-template (например `/:id/rounds`), а не из
 * конкретного URL — иначе histogram расплывётся на сотни уникальных UUID'ов.
 * Если route-template недоступен (например для 404/исключений) — пишем
 * `_other` как fallback, чтобы не терять семплы.
 */
@Injectable()
export class HttpDurationInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    // Применяем только к HTTP. Ws-сообщения сюда тоже падают, но у них нет
    // `switchToHttp().getRequest()` с route-template — наблюдать их смысла нет.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const start = process.hrtime.bigint();
    const route = this.resolveRoute(context);

    return next.handle().pipe(
      tap({
        next: () => this.record(route, start),
        error: () => this.record(route, start),
      }),
    );
  }

  private resolveRoute(context: ExecutionContext): string {
    const req = context.switchToHttp().getRequest<{
      route?: { path?: string };
      routerPath?: string;
      originalUrl?: string;
    }>();
    // Express: req.route.path (`/`, `/:id`, `/:id/rounds` …)
    if (req.route?.path) return req.route.path;
    // Fastify (на всякий случай): req.routerPath
    if (req.routerPath) return req.routerPath;
    return '_other';
  }

  private record(route: string, startNs: bigint): void {
    const diffNs = Number(process.hrtime.bigint() - startNs);
    this.metrics.observeHttpDuration(route, diffNs / 1e9);
  }
}
