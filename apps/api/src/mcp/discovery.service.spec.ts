/**
 * KS-2952 / ADR-061 §5/§7. Юнит-тесты McpDiscoveryService.
 *
 * Покрытие 5 уровней безопасности (ADR §11):
 *  1) hard-exclude by guard (MCP_FORBIDDEN_GUARDS),
 *  2) soft-exclude by path-segment (admin/internal),
 *  3) @McpExclude на классе,
 *  4) @McpExclude на методе,
 *  5) name override + collision.
 *
 * Тесты строят мини-«ModulesContainer» из обычных классов: класс
 * NestJS-модуля + контроллеры с декораторами `@Controller`, `@Get`,
 * `@Post`, `@UseGuards`, `@McpModule`, `@McpExclude`, `@McpTool`.
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
  Injectable,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModulesContainer } from '@nestjs/core';
import {
  McpModule,
  McpTool,
  McpExclude,
} from './decorators';
import { McpDiscoveryService } from './discovery.service';

// ── фейковые sensitive-guards (имена обязаны совпадать с MCP_FORBIDDEN_GUARDS).
@Injectable()
class AdminApiKeyGuard {
  canActivate(): boolean {
    return true;
  }
}
@Injectable()
class InternalKeyGuard {
  canActivate(): boolean {
    return true;
  }
}

function buildContainer(modules: Array<{
  metatype: object;
  controllers: Array<object>;
}>): ModulesContainer {
  // имитируем ModulesContainer как Map<string, {metatype, controllers}>;
  // controllers — Map<string, {metatype}>.
  const container = new Map();
  for (const m of modules) {
    container.set((m.metatype as { name?: string }).name ?? 'm', {
      metatype: m.metatype,
      controllers: new Map(
        m.controllers.map((c) => [
          (c as { name?: string }).name ?? 'c',
          { metatype: c },
        ]),
      ),
    });
  }
  return container as unknown as ModulesContainer;
}

function buildService(container: ModulesContainer): McpDiscoveryService {
  const config = {
    get: (_k: string) => undefined,
  } as unknown as ConfigService;
  return new McpDiscoveryService(container, config);
}

describe('McpDiscoveryService (KS-2952)', () => {
  it('1) hard-exclude by guard: контроллер с AdminApiKeyGuard скипается', () => {
    @Controller('safe')
    class SafeController {
      @Get() list() {}
    }
    @Controller('reports')
    @UseGuards(AdminApiKeyGuard)
    class ReportsController {
      @Get() list() {}
    }
    @McpModule({
      section: 'admin_mix',
      title: 'Admin Mix',
      description: 'Mixed module with sensitive controller.',
    })
    class FakeModule {}
    const svc = buildService(
      buildContainer([
        { metatype: FakeModule, controllers: [SafeController, ReportsController] },
      ]),
    );
    const cat = svc.build();
    const paths = cat.tools.map((t) => t.path);
    expect(paths).toContain('/safe');
    expect(paths).not.toContain('/reports');
    expect(svc.getStats().excludedByGuard).toBe(1);
  });

  it('2) soft-exclude by path-segment: путь /admin/* пропускается', () => {
    @Controller('admin/users')
    class AdminUsersCtl {
      @Get() list() {}
    }
    @Controller('users')
    class UsersCtl {
      @Get() list() {}
    }
    @McpModule({
      section: 'users_x',
      title: 'Users',
      description: 'Users + admin/users',
    })
    class FakeModule {}
    const svc = buildService(
      buildContainer([
        { metatype: FakeModule, controllers: [AdminUsersCtl, UsersCtl] },
      ]),
    );
    const cat = svc.build();
    expect(cat.tools.map((t) => t.path)).toEqual(['/users']);
    expect(svc.getStats().excludedByPath).toBe(1);
  });

  it('2b) soft-exclude путь /internal/* пропускается', () => {
    @Controller('internal/notify')
    class InternalCtl {
      @Post() send() {}
    }
    @McpModule({
      section: 'notify',
      title: 'Notify',
      description: 'Internal notifier',
    })
    class FakeModule {}
    const svc = buildService(
      buildContainer([{ metatype: FakeModule, controllers: [InternalCtl] }]),
    );
    const cat = svc.build();
    expect(cat.tools).toHaveLength(0);
    expect(svc.getStats().excludedByPath).toBe(1);
  });

  it('3) @McpExclude на классе → весь контроллер выкидывается', () => {
    @Controller('skipped')
    @McpExclude()
    class SkippedCtl {
      @Get() a() {}
      @Post() b() {}
    }
    @Controller('kept')
    class KeptCtl {
      @Get() a() {}
    }
    @McpModule({
      section: 'mix',
      title: 'Mix',
      description: 'Mix',
    })
    class FakeModule {}
    const svc = buildService(
      buildContainer([{ metatype: FakeModule, controllers: [SkippedCtl, KeptCtl] }]),
    );
    const cat = svc.build();
    expect(cat.tools.map((t) => t.path)).toEqual(['/kept']);
    expect(svc.getStats().excludedByDecorator).toBe(1);
  });

  it('4) @McpExclude на методе → конкретный handler выкидывается', () => {
    @Controller('items')
    class ItemsCtl {
      @Get() list() {}
      @McpExclude()
      @Post()
      create() {}
    }
    @McpModule({
      section: 'items',
      title: 'Items',
      description: 'Items',
    })
    class FakeModule {}
    const svc = buildService(
      buildContainer([{ metatype: FakeModule, controllers: [ItemsCtl] }]),
    );
    const cat = svc.build();
    expect(cat.tools).toHaveLength(1);
    expect(cat.tools[0].method).toBe('GET');
    expect(svc.getStats().excludedByDecorator).toBe(1);
  });

  it('5) @McpTool({name}) override + auth override модульного defaultAuth', () => {
    @Controller('analyses')
    class AnalysisCtl {
      @McpTool({ name: 'analyses__list', auth: 'user' })
      @Get()
      findAll() {}
    }
    @McpModule({
      section: 'analyses',
      title: 'Analyses',
      description: 'Analyses',
      defaultAuth: 'optional',
    })
    class FakeModule {}
    const svc = buildService(
      buildContainer([{ metatype: FakeModule, controllers: [AnalysisCtl] }]),
    );
    const cat = svc.build();
    expect(cat.tools[0].name).toBe('analyses__list');
    expect(cat.tools[0].auth).toBe('user');
  });

  it('5b) auto-generated tool name: <section>__<method snake_case>', () => {
    @Controller('analyses')
    class Ctl {
      @Get()
      findAllUsers() {}
    }
    @McpModule({
      section: 'analyses',
      title: 'A',
      description: 'A',
    })
    class M {}
    const svc = buildService(
      buildContainer([{ metatype: M, controllers: [Ctl] }]),
    );
    const cat = svc.build();
    expect(cat.tools[0].name).toBe('analyses__find_all_users');
  });

  it('5c) tool name collision → ошибка bootstrap', () => {
    @Controller('a')
    class Ctl {
      @McpTool({ name: 'duplicate' })
      @Get()
      x() {}
      @McpTool({ name: 'duplicate' })
      @Post()
      y() {}
    }
    @McpModule({ section: 'a', title: 'A', description: 'A' })
    class M {}
    const svc = buildService(
      buildContainer([{ metatype: M, controllers: [Ctl] }]),
    );
    expect(() => svc.build()).toThrow(/collision/);
  });

  it('Module без @McpModule полностью игнорируется (opt-in)', () => {
    @Controller('not-marked')
    class Ctl {
      @Get() list() {}
    }
    class FakeModule {}
    const svc = buildService(
      buildContainer([{ metatype: FakeModule, controllers: [Ctl] }]),
    );
    const cat = svc.build();
    expect(cat.tools).toHaveLength(0);
    expect(cat.sections).toHaveLength(0);
  });

  it('sections дедуплицируются если несколько модулей объявляют один section', () => {
    @Controller('puzzles')
    class C1 {
      @Get() list() {}
    }
    @Controller('puzzles/daily')
    class C2 {
      @Get() daily() {}
    }
    @McpModule({ section: 'puzzles', title: 'P', description: 'P' })
    class M1 {}
    @McpModule({ section: 'puzzles', title: 'P', description: 'P' })
    class M2 {}
    const svc = buildService(
      buildContainer([
        { metatype: M1, controllers: [C1] },
        { metatype: M2, controllers: [C2] },
      ]),
    );
    const cat = svc.build();
    expect(cat.sections).toHaveLength(1);
    expect(cat.tools).toHaveLength(2);
  });

  it('@UseGuards с не-sensitive guard НЕ исключает endpoint', () => {
    @Injectable()
    class JwtAuthGuard {
      canActivate() {
        return true;
      }
    }
    @Controller('safe')
    @UseGuards(JwtAuthGuard)
    class Ctl {
      @Get() list() {}
    }
    @McpModule({ section: 's', title: 'S', description: 'S' })
    class M {}
    const svc = buildService(
      buildContainer([{ metatype: M, controllers: [Ctl] }]),
    );
    const cat = svc.build();
    expect(cat.tools).toHaveLength(1);
  });

  it('InternalKeyGuard на методе тоже срабатывает hard-exclude', () => {
    @Controller('thing')
    class Ctl {
      @Get() list() {}
      @UseGuards(InternalKeyGuard)
      @Post()
      internalOnly() {}
    }
    @McpModule({ section: 'thing', title: 'T', description: 'T' })
    class M {}
    const svc = buildService(
      buildContainer([{ metatype: M, controllers: [Ctl] }]),
    );
    const cat = svc.build();
    expect(cat.tools.map((t) => t.method)).toEqual(['GET']);
    expect(svc.getStats().excludedByGuard).toBe(1);
  });
});
