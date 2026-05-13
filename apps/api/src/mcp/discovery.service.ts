/**
 * KS-2952 / ADR-061 §7. McpDiscoveryService.
 *
 * На `OnApplicationBootstrap` обходит `ModulesContainer`, для каждого
 * модуля помеченного `@McpModule()` собирает каталог его контроллеров.
 * Каталог кэшируется в памяти, инвалидация — только перезапуск
 * процесса (новых endpoint'ов в runtime не появляется).
 *
 * 5 уровней безопасности (ADR-061 §5/§11):
 *  1) hard-exclude by guard (`MCP_FORBIDDEN_GUARDS`),
 *  2) soft-exclude by path-segment (`MCP_FORBIDDEN_PATH_REGEX`),
 *  3) `@McpExclude` на классе,
 *  4) `@McpExclude` на методе,
 *  5) `MCP_DISCOVERY_KEY` на самом `/_mcp/tools` (см. guard).
 *
 * Логирование результатов:
 *   `[MCP] Discovered N tools across M sections. Excluded: X (path), Y (guard), Z (@McpExclude).`
 */
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  RequestMethod,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { ModulesContainer } from '@nestjs/core';
import {
  MCP_EXCLUDE,
  MCP_FORBIDDEN_GUARDS,
  MCP_FORBIDDEN_PATH_REGEX,
  MCP_MODULE_META,
  MCP_TOOL_META,
  McpAuth,
  McpModuleMeta,
  McpToolMeta,
} from './decorators';
import {
  classToJsonSchema,
  JsonSchemaObject,
} from './class-validator-to-jsonschema';

export interface McpCatalogSection {
  id: string;
  title: string;
  description: string;
  defaultAuth?: McpAuth;
}

export interface McpCatalogTool {
  name: string;
  section: string;
  method: string;
  path: string;
  description?: string;
  auth?: McpAuth;
  input: JsonSchemaObject;
  output: null;
  defaults?: { limit?: number };
  limits?: { maxLimit?: number };
  excludeFields?: string[];
  fieldsAllowList?: string[];
}

export interface McpCatalog {
  schemaVersion: 1;
  generatedAt: string;
  apiBaseUrl: string;
  sections: McpCatalogSection[];
  tools: McpCatalogTool[];
}

export interface McpDiscoveryStats {
  sections: number;
  tools: number;
  excludedByPath: number;
  excludedByGuard: number;
  excludedByDecorator: number;
}

@Injectable()
export class McpDiscoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger('McpDiscovery');
  private catalog: McpCatalog | null = null;
  private stats: McpDiscoveryStats = {
    sections: 0,
    tools: 0,
    excludedByPath: 0,
    excludedByGuard: 0,
    excludedByDecorator: 0,
  };

  constructor(
    private readonly modules: ModulesContainer,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.catalog = this.build();
    const s = this.stats;
    this.logger.log(
      `Discovered ${s.tools} tools across ${s.sections} sections. ` +
        `Excluded: ${s.excludedByPath} (path), ` +
        `${s.excludedByGuard} (guard), ` +
        `${s.excludedByDecorator} (@McpExclude).`,
    );
  }

  /** Полный каталог. Бросает если bootstrap ещё не прошёл. */
  getCatalog(): McpCatalog {
    if (!this.catalog) {
      throw new Error('McpDiscoveryService.getCatalog() called before bootstrap');
    }
    return this.catalog;
  }

  getStats(): McpDiscoveryStats {
    return { ...this.stats };
  }

  /**
   * Внутренний build — публичный только для unit-тестов (вызывается
   * напрямую без NestJS bootstrap'а).
   */
  build(): McpCatalog {
    this.stats = {
      sections: 0,
      tools: 0,
      excludedByPath: 0,
      excludedByGuard: 0,
      excludedByDecorator: 0,
    };
    const sections: McpCatalogSection[] = [];
    const tools: McpCatalogTool[] = [];
    const usedNames = new Set<string>();
    const sectionIds = new Set<string>();

    for (const module of this.modules.values()) {
      const metatype = module.metatype;
      if (!metatype) continue;

      const moduleMeta: McpModuleMeta | undefined = Reflect.getMetadata(
        MCP_MODULE_META,
        metatype,
      );
      if (!moduleMeta) continue;
      if (Reflect.getMetadata(MCP_EXCLUDE, metatype)) continue;

      if (!sectionIds.has(moduleMeta.section)) {
        sections.push({
          id: moduleMeta.section,
          title: moduleMeta.title,
          description: moduleMeta.description,
          defaultAuth: moduleMeta.defaultAuth,
        });
        sectionIds.add(moduleMeta.section);
      }

      for (const wrapper of module.controllers.values()) {
        const controllerClass = wrapper.metatype as
          | (new (...args: unknown[]) => unknown)
          | undefined;
        if (!controllerClass) continue;
        if (Reflect.getMetadata(MCP_EXCLUDE, controllerClass)) {
          this.stats.excludedByDecorator++;
          continue;
        }

        const controllerPath =
          (Reflect.getMetadata(PATH_METADATA, controllerClass) as string) ?? '';
        const controllerGuards =
          (Reflect.getMetadata(GUARDS_METADATA, controllerClass) as unknown[]) ??
          [];
        if (hasForbiddenGuard(controllerGuards)) {
          this.stats.excludedByGuard++;
          continue;
        }

        const proto = controllerClass.prototype as Record<
          string,
          unknown
        >;
        const methodNames = Object.getOwnPropertyNames(proto).filter(
          (n) => n !== 'constructor' && typeof proto[n] === 'function',
        );

        for (const methodName of methodNames) {
          const handler = proto[methodName] as (...args: unknown[]) => unknown;
          const methodPath = Reflect.getMetadata(PATH_METADATA, handler);
          if (methodPath === undefined) continue; // не request handler
          const httpMethod = Reflect.getMetadata(
            METHOD_METADATA,
            handler,
          ) as RequestMethod | undefined;

          if (Reflect.getMetadata(MCP_EXCLUDE, handler)) {
            this.stats.excludedByDecorator++;
            continue;
          }

          const methodGuards =
            (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? [];
          if (
            hasForbiddenGuard([...controllerGuards, ...methodGuards])
          ) {
            this.stats.excludedByGuard++;
            continue;
          }

          const fullPath = '/' + joinPath(controllerPath, String(methodPath));
          if (MCP_FORBIDDEN_PATH_REGEX.test(fullPath)) {
            this.stats.excludedByPath++;
            continue;
          }

          const toolMeta: McpToolMeta =
            (Reflect.getMetadata(MCP_TOOL_META, handler) as McpToolMeta) ?? {};
          if (toolMeta.excludeFields && toolMeta.fieldsAllowList) {
            // защита на случай рантайм-конфликта (в `@McpTool` уже
            // проверяется, дублируем для построения каталога).
            throw new Error(
              `MCP: ${controllerClass.name}.${methodName} имеет одновременно ` +
                `excludeFields и fieldsAllowList`,
            );
          }
          const auth: McpAuth | undefined =
            toolMeta.auth ?? moduleMeta.defaultAuth;
          const toolName =
            toolMeta.name ?? `${moduleMeta.section}__${toSnakeCase(methodName)}`;
          if (usedNames.has(toolName)) {
            throw new Error(
              `MCP tool name collision: '${toolName}' (см. ` +
                `${controllerClass.name}.${methodName})`,
            );
          }
          usedNames.add(toolName);

          tools.push({
            name: toolName,
            section: moduleMeta.section,
            method: httpMethodToString(httpMethod),
            path: fullPath,
            description: toolMeta.description,
            auth,
            input: this.buildInputSchema(controllerClass, methodName),
            output: null,
            defaults:
              toolMeta.defaultLimit !== undefined
                ? { limit: toolMeta.defaultLimit }
                : undefined,
            limits:
              toolMeta.maxLimit !== undefined
                ? { maxLimit: toolMeta.maxLimit }
                : undefined,
            excludeFields: toolMeta.excludeFields,
            fieldsAllowList: toolMeta.fieldsAllowList,
          });
          this.stats.tools++;
        }
      }
    }

    this.stats.sections = sections.length;

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      apiBaseUrl:
        this.config.get<string>('MCP_API_BASE_URL') ??
        process.env.MCP_API_BASE_URL ??
        '',
      sections,
      tools,
    };
  }

  /**
   * Собирает JSON Schema для query+body+param параметров метода.
   * Стратегия: берём `design:paramtypes`, для каждого class-типа,
   * который НЕ примитив (`String/Number/Boolean/...`) — считаем DTO
   * и раскрываем через `classToJsonSchema`. Если их несколько (Body
   * + Query DTO одновременно) — мерджим properties.
   *
   * Path-параметры не покрываются здесь (NestJS ROUTE_ARGS_METADATA —
   * непубличный API). При необходимости можно расширить, но фактически
   * path-параметры видны в `tool.path` как `:id`.
   */
  private buildInputSchema(
    // eslint-disable-next-line @typescript-eslint/ban-types
    controllerClass: Function,
    methodName: string,
  ): JsonSchemaObject {
    const proto = (controllerClass as { prototype?: object }).prototype;
    if (!proto) return { type: 'object', properties: {} };
    const paramTypes =
      (Reflect.getMetadata('design:paramtypes', proto, methodName) as
        | unknown[]
        | undefined) ?? [];

    const merged: JsonSchemaObject = { type: 'object', properties: {} };
    const required = new Set<string>();
    for (const pt of paramTypes) {
      if (typeof pt !== 'function') continue;
      if (PRIMITIVES.has(pt as unknown as new () => unknown)) continue;
      // Object — например `@Request() req: AuthenticatedRequest`. Это
      // не DTO с валидаторами — пропускаем.
      if (pt === Object) continue;
      try {
        const sub = classToJsonSchema(
          pt as unknown as new () => unknown,
          { warn: (msg) => this.logger.warn(msg) },
        );
        for (const [k, v] of Object.entries(sub.properties)) {
          // first-wins при коллизии имён — query и body не должны
          // пересекаться по полям в нашем коде, но если такое случится,
          // оставляем первое определение и логируем warn.
          if (merged.properties[k]) {
            this.logger.warn(
              `[mcp:schema] Коллизия поля '${k}' между параметрами ` +
                `${(controllerClass as { name?: string }).name}.${methodName}; ` +
                `оставляю первое определение`,
            );
            continue;
          }
          merged.properties[k] = v;
        }
        for (const r of sub.required ?? []) required.add(r);
      } catch (e) {
        this.logger.warn(
          `[mcp:schema] Не удалось построить схему для параметра ` +
            `${(controllerClass as { name?: string }).name}.${methodName}: ${(e as Error).message}`,
        );
      }
    }
    if (required.size > 0) merged.required = [...required];
    return merged;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function hasForbiddenGuard(guards: unknown[]): boolean {
  for (const g of guards) {
    const name =
      typeof g === 'function'
        ? (g as { name?: string }).name
        : (g as { constructor?: { name?: string } } | undefined)?.constructor?.name;
    if (name && MCP_FORBIDDEN_GUARDS.includes(name)) return true;
  }
  return false;
}

function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/');
}

function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function httpMethodToString(m: RequestMethod | undefined): string {
  switch (m) {
    case RequestMethod.GET:
      return 'GET';
    case RequestMethod.POST:
      return 'POST';
    case RequestMethod.PUT:
      return 'PUT';
    case RequestMethod.DELETE:
      return 'DELETE';
    case RequestMethod.PATCH:
      return 'PATCH';
    case RequestMethod.OPTIONS:
      return 'OPTIONS';
    case RequestMethod.HEAD:
      return 'HEAD';
    case RequestMethod.ALL:
      return 'ALL';
    case RequestMethod.SEARCH:
      return 'SEARCH';
    default:
      return 'GET';
  }
}

// eslint-disable-next-line @typescript-eslint/ban-types
const PRIMITIVES = new Set<Function>([
  String,
  Number,
  Boolean,
  Array,
  Date,
  Buffer,
]);
