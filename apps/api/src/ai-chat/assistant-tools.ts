/**
 * KS-3205 / ADR-074 §10 B1 — контракт для tool-use loop'а в
 * `ChatAssistantService`. КS-3206 подключит реальный
 * `McpAssistantRegistry`; до этого момента работает no-op-провайдер,
 * у которого нет ни одного tool'а — поведение чата идентично прежнему
 * (без tools).
 */

/**
 * JSON-schema описание tool'а — отдаётся в Anthropic Messages API как
 * элемент массива `tools`. Тип сужен относительно SDK'шного
 * `Anthropic.Tool`, чтобы не тащить SDK во все слои.
 */
export interface AnthropicToolDef {
  /** Имя tool'а (snake_case или `section__action`, как в MCP). */
  name: string;
  /** Описание для модели — что делает, когда вызывать. */
  description: string;
  /**
   * JSON-schema аргументов. Обязательно `type:'object'` (требование API).
   * Поля `properties` / `required` — стандартный JSON-schema.
   */
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    [extra: string]: unknown;
  };
}

/**
 * Контракт для провайдера tool'ов: для конкретного userId возвращает
 * список tool'ов (фильтрация по правам/секциям — забота реализации) и
 * выполняет tool по имени.
 *
 * Реализации:
 *   - `NoOpAssistantToolsProvider` (B1) — пустой каталог.
 *   - `McpAssistantRegistry` (KS-3206) — обёртка над MCP-каталогом.
 */
export interface AssistantToolsProvider {
  /** Tool-каталог для текущего пользователя. Пусто → без tool-use. */
  listTools(userId: string): Promise<AnthropicToolDef[]>;
  /**
   * Выполнить tool по имени.
   * @returns строковое содержимое для `tool_result.content`. Длинные
   *   массивы/объекты сериализуются через JSON.stringify самой
   *   реализацией — модель ожидает string.
   * @throws ошибку с понятным `message` — caller обернёт в
   *   `tool_result { is_error: true, content: error.message }`.
   */
  execute(userId: string, name: string, input: unknown): Promise<string>;
}

/**
 * Без tool'ов — поведение до KS-3206. Используется как DI-default,
 * чтобы существующие тесты `ChatAssistantService` не ломались.
 */
export class NoOpAssistantToolsProvider implements AssistantToolsProvider {
  async listTools(_userId: string): Promise<AnthropicToolDef[]> {
    return [];
  }

  async execute(_userId: string, name: string, _input: unknown): Promise<string> {
    throw new Error(`Tool '${name}' is not available (no provider registered)`);
  }
}

/**
 * DI-токен — на него регистрируется реальный провайдер из KS-3206
 * (вместо `NoOpAssistantToolsProvider`).
 */
export const ASSISTANT_TOOLS_PROVIDER = Symbol('AssistantToolsProvider');

/**
 * KS-3205. SSE-event'ы, которые `ChatAssistantService.streamResponse`
 * отдаёт наружу. Controller сериализует каждый в одну `data:` строку.
 *
 *   - `text`      — токены финального assistant-сообщения.
 *   - `tool_call` — стадии выполнения tool'а: `running` (старт),
 *                   `ok` (успех, есть `output`) / `error` (есть `error`).
 *                   `input` — то, что отдала модель в `tool_use.input`.
 *   - `error`     — фатальная ошибка цикла (модель/таймаут/MAX_TURNS).
 *                   Stream после этого прекращается.
 *   - `done`      — нормальное завершение, можно слать `[DONE]` на фронт.
 */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
      status: 'running' | 'ok' | 'error';
      output?: string;
      error?: string;
    }
  | { type: 'error'; error: string }
  | { type: 'done' };

/**
 * KS-3205 / ADR-074 §10 B1. Лимит итераций tool-use loop'а.
 *
 * KS-3226 / ADR-075 §7 B6: поднят 8 → 16. M2-сценарии (mixed-урок:
 * create_user_course → create_user_lesson → 5-15 step-вызовов разных
 * типов → get_user_course_url) легко выходят за 8 turn'ов.
 */
export const MAX_TOOL_TURNS = 16;
