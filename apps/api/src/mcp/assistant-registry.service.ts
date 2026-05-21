/**
 * KS-3206 / ADR-074 §10 B2. McpAssistantRegistry.
 *
 * На `OnApplicationBootstrap` обходит `ModulesContainer`, для каждого
 * controller'а собирает методы, помеченные `@McpToolForAssistant()`.
 * Из метаданных + `class-validator → JSON-schema` строит итоговый
 * `AnthropicToolDef[]`, который потом отдаётся в Anthropic Messages API
 * (см. `ChatAssistantService.streamResponse`, KS-3205).
 *
 * Реализует `AssistantToolsProvider` (см. `ai-chat/assistant-tools.ts`):
 *   - `listTools(userId)` — общий список (filtering by user — KS-3207+).
 *   - `execute(userId, name, input)` — вызывает контроллер-метод через
 *     ModuleRef. Аргументы подбираются на основе Nest'овских
 *     `design:paramtypes` (см. mapHandlerArgs ниже).
 *
 * Параллельный канал с `McpDiscoveryService` (ADR-061): тот же handler
 * может быть и MCP-tool'ом, и assistant-tool'ом — мы намеренно работаем
 * с разными метаданными (`MCP_ASSISTANT_TOOL_META` vs `MCP_TOOL_META`)
 * и не трогаем существующие 80+ маркеров.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  type Type,
} from '@nestjs/common';
import { ModuleRef, ModulesContainer } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AnthropicToolDef,
  AssistantToolsProvider,
} from '../ai-chat/assistant-tools';
import {
  classToJsonSchema,
  JsonSchemaObject,
} from './class-validator-to-jsonschema';
import {
  MCP_ASSISTANT_TOOL_META,
  MCP_EXCLUDE,
  McpAssistantToolMeta,
} from './decorators';

/**
 * Один зарегистрированный assistant-tool. Хранится в реестре до
 * выполнения; `def` отдаётся в Anthropic, остальное нужно для execute.
 */
interface AssistantToolEntry {
  def: AnthropicToolDef;
  controllerClass: Type<unknown>;
  methodName: string;
  /** `design:paramtypes` метода (для построения вызова). */
  paramTypes: unknown[];
}

@Injectable()
export class McpAssistantRegistry
  implements OnApplicationBootstrap, AssistantToolsProvider
{
  private readonly logger = new Logger('McpAssistantRegistry');
  /** Имя tool'а → запись. */
  private readonly registry = new Map<string, AssistantToolEntry>();

  constructor(
    private readonly modules: ModulesContainer,
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    this.build();
    this.logger.log(
      `Discovered ${this.registry.size} assistant tool(s): ` +
        [...this.registry.keys()].join(', '),
    );
  }

  /**
   * Доступные tool'ы. Сейчас один общий список для всех пользователей;
   * future per-user фильтрация (KS-3207+, например, по фиче-флагам или
   * правам) подключается здесь.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTools(_userId: string): Promise<AnthropicToolDef[]> {
    return [...this.registry.values()].map((e) => e.def);
  }

  async execute(
    userId: string,
    name: string,
    input: unknown,
  ): Promise<string> {
    const entry = this.registry.get(name);
    if (!entry) {
      throw new Error(`Tool '${name}' is not registered`);
    }
    const instance = this.moduleRef.get(entry.controllerClass, {
      strict: false,
    });
    if (!instance) {
      throw new Error(
        `Tool '${name}': cannot resolve instance of ` +
          `${entry.controllerClass.name} from DI`,
      );
    }
    const method = (instance as Record<string, unknown>)[entry.methodName];
    if (typeof method !== 'function') {
      throw new Error(
        `Tool '${name}': method ${entry.controllerClass.name}.${entry.methodName} not found`,
      );
    }
    // KS-3207: валидируем input через class-validator на основе типа
    // первого непримитивного параметра (DTO-класс). Это эмулирует
    // NestJS ValidationPipe, которую мы обходим при прямом invoke.
    // Без этой проверки ассистент мог бы прислать поля, не описанные
    // в схеме, и обойти бизнес-лимиты.
    const validatedInput = await this.validateInput(entry, input);
    const args = this.mapHandlerArgs(entry, validatedInput, userId);
    const result = await (method as (...a: unknown[]) => unknown).apply(
      instance,
      args,
    );
    return typeof result === 'string'
      ? result
      : JSON.stringify(result ?? null);
  }

  /**
   * Прогоняет `input` через class-transformer (`plainToInstance`) и
   * class-validator на основе типа первого непримитивного параметра.
   * Если такой параметр — `Object` или примитив (нет DTO-класса), —
   * возвращает input без изменений.
   *
   * Бросает `BadRequestException` с человекочитаемым сообщением, если
   * валидация не прошла — это улетит в Anthropic как
   * `tool_result.is_error=true` (см. KS-3205 §loop).
   */
  private async validateInput(
    entry: AssistantToolEntry,
    input: unknown,
  ): Promise<unknown> {
    const inputClass = entry.paramTypes.find(
      (pt): pt is Type<unknown> =>
        typeof pt === 'function' &&
        !PRIMITIVES.has(pt as unknown as new () => unknown) &&
        pt !== Object,
    );
    if (!inputClass) return input;
    const dto = plainToInstance(
      inputClass as unknown as new () => unknown,
      input ?? {},
    );
    const errors = await validate(dto as object, {
      whitelist: true,
      forbidNonWhitelisted: false,
    });
    if (errors.length > 0) {
      const flat: string[] = [];
      const walk = (e: { property: string; constraints?: Record<string, string>; children?: unknown[] }, prefix: string): void => {
        const key = prefix ? `${prefix}.${e.property}` : e.property;
        for (const msg of Object.values(e.constraints ?? {})) {
          flat.push(`${key}: ${msg}`);
        }
        for (const c of (e.children ?? []) as Array<typeof e>) {
          walk(c, key);
        }
      };
      for (const e of errors) walk(e as any, '');
      throw new BadRequestException(
        `Tool '${entry.def.name}' input validation failed: ${flat.join('; ')}`,
      );
    }
    return dto;
  }

  /**
   * Build/rebuild реестр. Public только для тестов — обычно вызывается
   * один раз в `onApplicationBootstrap`.
   */
  build(): void {
    this.registry.clear();
    for (const module of this.modules.values()) {
      // KS-3207: tools могут жить и на @Controller'ах (для отметки
      // существующих handler'ов), и на @Injectable() сервисах (адаптеры,
      // спроектированные под ассистент). Сканируем оба источника.
      // `controllers` / `providers` могут отсутствовать в тестовых
      // подделках `ModulesContainer` — защищаемся guard'ами.
      const controllersIter = module.controllers?.values?.() ?? [];
      const providersIter = module.providers?.values?.() ?? [];
      const candidates: Array<{ metatype: unknown }> = [
        ...controllersIter,
        ...providersIter,
      ];
      const seen = new Set<Type<unknown>>();
      for (const wrapper of candidates) {
        const metatype = wrapper.metatype as unknown;
        const controllerClass =
          typeof metatype === 'function' ? (metatype as Type<unknown>) : undefined;
        if (!controllerClass) continue;
        if (seen.has(controllerClass)) continue;
        seen.add(controllerClass);
        if (Reflect.getMetadata(MCP_EXCLUDE, controllerClass)) continue;

        const proto = (controllerClass.prototype ?? null) as
          | Record<string, unknown>
          | null;
        if (!proto) continue; // useValue-провайдеры, anonymous classes без proto
        // KS-3207: некоторые NestJS-внутренние провайдеры (ModuleRef и
        // т.п.) имеют prototype-getter'ы, которые бросают при чтении вне
        // живого application context'а. Защищаемся try/catch — нас
        // интересуют только обычные классы с @McpToolForAssistant.
        const methodNames = Object.getOwnPropertyNames(proto).filter((n) => {
          if (n === 'constructor') return false;
          try {
            return typeof proto[n] === 'function';
          } catch {
            return false;
          }
        });

        for (const methodName of methodNames) {
          const handler = proto[methodName] as (...a: unknown[]) => unknown;
          const meta = Reflect.getMetadata(
            MCP_ASSISTANT_TOOL_META,
            handler,
          ) as McpAssistantToolMeta | undefined;
          if (!meta) continue;
          if (Reflect.getMetadata(MCP_EXCLUDE, handler)) continue;

          const toolName = meta.name ?? this.deriveToolName(controllerClass, methodName);
          if (this.registry.has(toolName)) {
            throw new Error(
              `assistant tool name collision: '${toolName}' (` +
                `${controllerClass.name}.${methodName})`,
            );
          }

          const paramTypes =
            (Reflect.getMetadata(
              'design:paramtypes',
              proto,
              methodName,
            ) as unknown[] | undefined) ?? [];

          const inputSchema =
            meta.inputSchema ?? this.deriveInputSchema(paramTypes);
          this.registry.set(toolName, {
            def: {
              name: toolName,
              description: meta.description,
              input_schema: inputSchema,
            },
            controllerClass,
            methodName,
            paramTypes,
          });
        }
      }
    }
  }

  /** Имя tool'а: `<controller_snake>__<method_snake>` (без суффикса Controller). */
  private deriveToolName(controllerClass: Type<unknown>, methodName: string): string {
    const slug = (controllerClass.name ?? 'ctrl')
      .replace(/Controller$/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase();
    const method = methodName
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase();
    return `${slug}__${method}`;
  }

  /**
   * Эвристика: ищем первый `design:paramtypes` — это не примитив, не
   * Object и поддаётся `classToJsonSchema` (DTO с class-validator).
   * Тот же подход использует McpDiscoveryService для своих tools (см.
   * ADR-061 §7) — переиспользуем helper, чтобы словарь полей был
   * одинаков.
   */
  private deriveInputSchema(paramTypes: unknown[]): AnthropicToolDef['input_schema'] {
    const empty: AnthropicToolDef['input_schema'] = {
      type: 'object',
      properties: {},
    };
    for (const pt of paramTypes) {
      if (typeof pt !== 'function') continue;
      if (PRIMITIVES.has(pt as unknown as new () => unknown)) continue;
      if (pt === Object) continue;
      try {
        const sub: JsonSchemaObject = classToJsonSchema(
          pt as new () => unknown,
          { warn: (msg) => this.logger.warn(msg) },
        );
        return {
          type: 'object',
          properties: sub.properties,
          ...(sub.required && sub.required.length > 0
            ? { required: sub.required }
            : {}),
        };
      } catch (e) {
        this.logger.warn(
          `[assistant-tool:schema] не удалось вывести JSON Schema: ` +
            (e as Error).message,
        );
      }
    }
    return empty;
  }

  /**
   * Соответствие input → args метода. Простая позиционная эвристика:
   *   1-й непримитивный параметр → `input` (это «DTO» — то, что модель
   *     отдала через tool_use.input);
   *   2-й и далее непримитивный параметр → синтетический request-like
   *     `{ user: { id: userId } }` (этого хватает для большинства
   *     handler'ов, которым нужен `req.user.id`);
   *   примитивы / Date / Buffer → `undefined`.
   *
   * Точечного маппинга через Nest'овский `ROUTE_ARGS_METADATA` пока не
   * делаем — assistant-tools задумывались как методы-сервисы, не как
   * полноценные HTTP-handler'ы (см. ADR-074 §10 B2). Если конкретному
   * tool нужен иной маппинг — он принимает один объект-аргумент и
   * сам разбирает структуру.
   */
  private mapHandlerArgs(
    entry: AssistantToolEntry,
    input: unknown,
    userId: string,
  ): unknown[] {
    let nonPrimitiveSeen = 0;
    return entry.paramTypes.map((pt) => {
      if (typeof pt !== 'function') return undefined;
      if (PRIMITIVES.has(pt as unknown as new () => unknown)) return undefined;
      nonPrimitiveSeen += 1;
      if (nonPrimitiveSeen === 1) return input;
      if (nonPrimitiveSeen === 2) return { user: { id: userId } };
      return undefined;
    });
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
