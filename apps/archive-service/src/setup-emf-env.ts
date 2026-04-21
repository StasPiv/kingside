/**
 * Принудительно включает Local-mode для `aws-embedded-metrics` ДО того,
 * как эта библиотека будет загружена транзитивно (через
 * `EmfMetricsPublisher`).
 *
 * Почему именно side-effect модуль, а не `Configuration.environmentOverride`
 * в конструкторе publisher'а:
 *
 *   `aws-embedded-metrics` на module-load стартует `environmentPromise`
 *   (см. `lib/environment/EnvironmentDetector.js:104`) — async-цепочка
 *   `_resolveEnvironment()` выполняется синхронно до первого `await`,
 *   и решение о sink'е (stdout vs TCP к EMF Agent `0.0.0.0:25888`)
 *   принимается в этот момент. `Configuration.environmentOverride`,
 *   выставленный ПОСЛЕ импорта библиотеки, уже не подхватится —
 *   экспериментально подтверждено: даже после программного override'а
 *   `flush()` падает `ECONNREFUSED 0.0.0.0:25888` на Fargate без
 *   EMF Agent sidecar'а.
 *
 *   Надёжный способ — env-переменная `AWS_EMF_ENVIRONMENT=Local`
 *   (читается в `lib/config/EnvironmentConfigurationProvider.js:60` при
 *   первом `require('aws-embedded-metrics')`). Её нужно выставить ДО
 *   того, как библиотека загрузится транзитивно через `require` graph.
 *
 *   TypeScript в CJS output сохраняет порядок `require()` вызовов как
 *   в исходнике. Поэтому этот файл импортируется side-effect-ом вторым
 *   (после `reflect-metadata`) в `importer-once.ts`, до импорта
 *   `ImporterOnceModule` → `EmfMetricsPublisher` → `aws-embedded-metrics`.
 *
 * Если оператор сам выставил `AWS_EMF_ENVIRONMENT` в task-def — его
 * выбор сохраняется (идемпотентная установка только при unset).
 *
 * ADR-020 §2.5 явно требует stdout EMF для Fargate + awslogs driver —
 * CloudWatch Logs сам парсит `_aws.CloudWatchMetrics` и публикует
 * метрики, sidecar EMF Agent не нужен.
 */

if (process.env.AWS_EMF_ENVIRONMENT === undefined) {
  process.env.AWS_EMF_ENVIRONMENT = 'Local';
}
