/**
 * Unit-тесты `McpAssistantRegistry` (KS-3206 / ADR-074 §10 B2).
 *
 * Поднимаем минимальный NestJS-модуль с fake-контроллером, на котором
 * один метод помечен `@McpToolForAssistant`, второй — без маркера.
 * Проверяем:
 *   1. реестр собирает только методы с маркером;
 *   2. имя автогенерируется как `<controller_snake>__<method_snake>`;
 *   3. явное `name` в декораторе побеждает дефолт;
 *   4. listTools отдаёт `AnthropicToolDef[]` с описанием и
 *      input_schema (минимум — `type:'object'`);
 *   5. execute резолвит инстанс через DI и вызывает метод, входной
 *      объект приходит первым аргументом, `req.user.id` подставляется;
 *   6. неизвестный tool → ошибка;
 *   7. `@McpExclude` на классе/методе исключает tool из реестра;
 *   8. коллизия имён → throw при build'е.
 */

import 'reflect-metadata';
import { Controller, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { McpAssistantRegistry } from './assistant-registry.service';
import { McpExclude, McpToolForAssistant } from './decorators';

class CapturedInput {
  // Подсмотрим, что execute дёрнул именно наш метод с этими args.
  static lastArgs: unknown[] | null = null;
}

@Controller('test-tools')
class FakeToolsController {
  @McpToolForAssistant({
    description: 'Echoes the message back to the assistant',
  })
  async echo(input: { message: string }, req: { user: { id: string } }) {
    CapturedInput.lastArgs = [input, req];
    return { echoed: input.message, userId: req.user.id };
  }

  @McpToolForAssistant({
    name: 'custom_named_tool',
    description: 'Tool with explicit name',
  })
  // eslint-disable-next-line @typescript-eslint/require-await
  async other(input: { x: number }) {
    return `x=${input.x}`;
  }

  // без маркера → не должен попасть в реестр
  // eslint-disable-next-line @typescript-eslint/require-await
  async untouched() {
    return 'never';
  }

  @McpExclude()
  @McpToolForAssistant({ description: 'excluded by decorator' })
  // eslint-disable-next-line @typescript-eslint/require-await
  async excluded() {
    return 'never';
  }
}

@Module({ controllers: [FakeToolsController] })
class FakeToolsModule {}

describe('McpAssistantRegistry (KS-3206)', () => {
  let registry: McpAssistantRegistry;

  beforeEach(async () => {
    CapturedInput.lastArgs = null;
    const moduleRef = await Test.createTestingModule({
      imports: [FakeToolsModule],
      providers: [McpAssistantRegistry],
    }).compile();
    registry = moduleRef.get(McpAssistantRegistry);
    registry.build(); // обычно — onApplicationBootstrap; для теста дёргаем вручную
  });

  it('собирает только методы с @McpToolForAssistant', async () => {
    const tools = await registry.listTools('user-1');
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'custom_named_tool',
      'fake_tools__echo',
    ]);
  });

  it('автогенерирует имя как <controller_snake>__<method_snake>', async () => {
    const tools = await registry.listTools('user-1');
    const echo = tools.find((t) => t.name === 'fake_tools__echo');
    expect(echo).toBeDefined();
    expect(echo!.description).toBe('Echoes the message back to the assistant');
    expect(echo!.input_schema.type).toBe('object');
  });

  it('явное name в декораторе побеждает дефолт', async () => {
    const tools = await registry.listTools('user-1');
    expect(tools.some((t) => t.name === 'custom_named_tool')).toBe(true);
    expect(tools.some((t) => t.name === 'fake_tools__other')).toBe(false);
  });

  it('@McpExclude на методе исключает tool из реестра', async () => {
    const tools = await registry.listTools('user-1');
    expect(tools.some((t) => t.name.includes('excluded'))).toBe(false);
  });

  it('execute резолвит инстанс через DI и вызывает метод', async () => {
    const result = await registry.execute('user-42', 'fake_tools__echo', {
      message: 'hi',
    });
    // result сериализуется в строку.
    expect(JSON.parse(result)).toEqual({ echoed: 'hi', userId: 'user-42' });
    expect(CapturedInput.lastArgs).toEqual([
      { message: 'hi' },
      { user: { id: 'user-42' } },
    ]);
  });

  it('execute для неизвестного tool кидает ошибку', async () => {
    await expect(
      registry.execute('user-1', 'unknown_tool', {}),
    ).rejects.toThrow(/not registered/);
  });

  it('@McpExclude на классе исключает все его tools', async () => {
    @Controller('excluded')
    @McpExclude()
    class ExcludedController {
      @McpToolForAssistant({ description: 'will not appear' })
      // eslint-disable-next-line @typescript-eslint/require-await
      async hidden() {
        return 'hidden';
      }
    }
    @Module({ controllers: [ExcludedController] })
    class ExcludedModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ExcludedModule, FakeToolsModule],
      providers: [McpAssistantRegistry],
    }).compile();
    const reg = moduleRef.get(McpAssistantRegistry);
    reg.build();
    const names = (await reg.listTools('u')).map((t) => t.name);
    expect(names).not.toContain('excluded__hidden');
    // другие tools продолжают регистрироваться
    expect(names).toContain('fake_tools__echo');
  });

  it('коллизия имён tool → throw при build()', () => {
    @Controller('a')
    class ControllerA {
      @McpToolForAssistant({ name: 'duplicate', description: 'A' })
      // eslint-disable-next-line @typescript-eslint/require-await
      async one() {
        return 'one';
      }
    }
    @Controller('b')
    class ControllerB {
      @McpToolForAssistant({ name: 'duplicate', description: 'B' })
      // eslint-disable-next-line @typescript-eslint/require-await
      async two() {
        return 'two';
      }
    }
    // Async-сборку не используем — Test.createTestingModule плохо
    // дружит с фейковыми Controller-классами без HTTP-биндинга в
    // отдельных модулях. Вместо этого подменяем `modules`-маппинг
    // вручную через приватное поле — это допустимо для теста build'а.
    const fakeModules = new Map<unknown, { controllers: Map<unknown, { metatype: unknown }> }>([
      [
        Symbol('m1'),
        {
          controllers: new Map([
            [Symbol('c1'), { metatype: ControllerA }],
            [Symbol('c2'), { metatype: ControllerB }],
          ]),
        },
      ],
    ]);
    const reg = new McpAssistantRegistry(
      fakeModules as unknown as ConstructorParameters<typeof McpAssistantRegistry>[0],
      {} as ConstructorParameters<typeof McpAssistantRegistry>[1],
    );
    expect(() => reg.build()).toThrow(/name collision/);
  });
});
