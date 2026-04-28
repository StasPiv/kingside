/**
 * KS-2095 follow-up — страховочный shim для `js-yaml`.
 *
 * Билд apps/api в проде падал на TS7016 «Could not find a declaration
 * file for module 'js-yaml'», когда devops при деплое не успевал
 * обновить `package-lock.json` после добавления `@types/js-yaml` в
 * `apps/api/package.json` (см. follow-up commit b54e5a21).
 *
 * Этот shim даёт TypeScript минимально-достаточную декларацию модуля,
 * чтобы tsc не падал даже при отсутствии `@types/js-yaml` в node_modules.
 * Когда полные типы доступны (после следующего `npm install` в проде)
 * — `@types/js-yaml` имеет приоритет автоматически (он autoloaded через
 * `node_modules/@types/`), а этот shim становится no-op.
 *
 * Соответственно safe-net действует только в окне «package.json уже
 * декларирует @types/js-yaml, но lock ещё не пересобран». Дальше — сам
 * пакет `@types/js-yaml` отдаёт корректные типы, и shim не используется.
 */
declare module 'js-yaml';
