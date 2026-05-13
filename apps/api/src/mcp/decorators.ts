/**
 * KS-2952 / ADR-061 §5. Декораторы MCP auto-discovery.
 *
 * Назначение:
 *  - `@McpModule()` ставится на NestJS-модуль и включает все его
 *    контроллеры/методы в каталог `/_mcp/tools` (opt-in на модуле,
 *    п. ADR-061 §3 решение «комбо»).
 *  - `@McpTool()` опционально переопределяет описание/лимиты/исключения
 *    полей на конкретном handler-методе.
 *  - `@McpExclude()` исключает класс или метод из каталога.
 *
 * Метаданные читаются `McpDiscoveryService` через `Reflect.getMetadata`.
 * Используем строковые ключи (а не `Symbol`) чтобы можно было удобно
 * читать их в тестах и в DevTools.
 */

export const MCP_MODULE_META = 'mcp:module-meta';
export const MCP_TOOL_META = 'mcp:tool-meta';
export const MCP_EXCLUDE = 'mcp:exclude';

export type McpAuth = 'user' | 'public' | 'optional';

export interface McpModuleMeta {
  /** Машинный id раздела (стабильный, snake_case). Пример: `analyses`. */
  section: string;
  /** Заголовок раздела (RU) для системного промта ассистента. */
  title: string;
  /**
   * Описание раздела (RU, 1-3 предложения). Отвечает на вопрос
   * «о чём этот раздел и когда туда идти».
   */
  description: string;
  /**
   * Дефолтный auth для всех методов раздела. Переопределяется
   * `@McpTool({auth})` на методе.
   */
  defaultAuth?: McpAuth;
}

export interface McpToolMeta {
  /** Переопределить автогенерируемое имя тула. */
  name?: string;
  /** Описание метода (RU). Если нет — берётся JSDoc. */
  description?: string;
  /** Auth для метода (override модульного `defaultAuth`). */
  auth?: McpAuth;
  /** Подсказка дефолтного `limit` для MCP-сервера. */
  defaultLimit?: number;
  /** Подсказка максимального `limit` для MCP-сервера. */
  maxLimit?: number;
  /**
   * Поля, которые MCP-сервер вырезает из ответа. Защита от token-limit
   * `tool_result`. Поддерживает dot-path вида `'items[].pgn'`.
   */
  excludeFields?: string[];
  /**
   * Whitelist полей. Взаимоисключающе с `excludeFields` (ошибка
   * bootstrap'а если оба заданы).
   */
  fieldsAllowList?: string[];
}

export function McpModule(meta: McpModuleMeta): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(MCP_MODULE_META, meta, target);
  };
}

export function McpTool(meta: McpToolMeta = {}): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    if (meta.excludeFields && meta.fieldsAllowList) {
      const cls = (target as object)?.constructor?.name ?? 'anonymous';
      throw new Error(
        `@McpTool on ${cls}.${String(propertyKey)}: ` +
          `excludeFields и fieldsAllowList взаимоисключающи (ADR-061 §5)`,
      );
    }
    const value = (descriptor as PropertyDescriptor)?.value;
    if (value) {
      Reflect.defineMetadata(MCP_TOOL_META, meta, value);
    }
  };
}

/**
 * `@McpExclude()` — на классе исключает весь контроллер, на методе —
 * конкретный handler. Декоратор универсальный (ClassDecorator &
 * MethodDecorator) с runtime-различением по числу аргументов.
 */
export function McpExclude(): ClassDecorator & MethodDecorator {
  return ((
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    if (propertyKey !== undefined && descriptor && descriptor.value) {
      Reflect.defineMetadata(MCP_EXCLUDE, true, descriptor.value);
    } else {
      Reflect.defineMetadata(MCP_EXCLUDE, true, target);
    }
  }) as ClassDecorator & MethodDecorator;
}

/**
 * KS-2952 / ADR-061 §5 уровень 1 (hard exclude by guard).
 *
 * Имена guard-классов, при наличии которых на классе/методе endpoint
 * НИКОГДА не попадает в каталог. Список — однопроходно поддерживаем
 * здесь; при добавлении нового sensitive-guard добавлять имя сюда.
 */
export const MCP_FORBIDDEN_GUARDS: readonly string[] = [
  'AdminApiKeyGuard',
  'AdminUserGuard',
  'AdminEmailGuard',
  'InternalKeyGuard',
];

/**
 * KS-2952 / ADR-061 §5 уровень 2 (soft exclude by path-segment).
 *
 * Регэксп для проверки полного пути endpoint'а. Если хоть один сегмент
 * совпадает — endpoint скипается даже если все guards чистые.
 * Это страховка на случай, если кто-то прикрутит admin-функционал
 * через interceptor/middleware и hard-фильтр не сработает.
 */
export const MCP_FORBIDDEN_PATH_REGEX = /(?:^|\/)(admin|internal)(?:\/|$)/;
