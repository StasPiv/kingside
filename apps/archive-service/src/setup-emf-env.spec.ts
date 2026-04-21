/**
 * Тесты для `setup-emf-env.ts` — проверяем что env-переменная
 * `AWS_EMF_ENVIRONMENT` устанавливается в `Local` если не задана,
 * и не перетирается если оператор её выставил (например, в ECS
 * task-def).
 *
 * jest.isolateModules нужен чтобы side-effect `require(...)` выполнялся
 * заново в каждом тесте — иначе module-cache отдаст результат первого
 * вызова и мы не проверим повторные выставления.
 */

describe('setup-emf-env', () => {
  const originalValue = process.env.AWS_EMF_ENVIRONMENT;

  afterEach(() => {
    // Вернуть оригинальное значение между тестами.
    if (originalValue === undefined) {
      delete process.env.AWS_EMF_ENVIRONMENT;
    } else {
      process.env.AWS_EMF_ENVIRONMENT = originalValue;
    }
  });

  it('устанавливает AWS_EMF_ENVIRONMENT=Local, если переменная не задана', () => {
    delete process.env.AWS_EMF_ENVIRONMENT;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./setup-emf-env');
    });
    expect(process.env.AWS_EMF_ENVIRONMENT).toBe('Local');
  });

  it('НЕ перетирает AWS_EMF_ENVIRONMENT, если оператор выставил (например Agent или ECS)', () => {
    process.env.AWS_EMF_ENVIRONMENT = 'Agent';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./setup-emf-env');
    });
    expect(process.env.AWS_EMF_ENVIRONMENT).toBe('Agent');
  });

  it('НЕ перетирает пустую строку (оператор намеренно отключил override)', () => {
    process.env.AWS_EMF_ENVIRONMENT = '';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./setup-emf-env');
    });
    // Пустая строка — это "уже задано оператором", не трогаем.
    expect(process.env.AWS_EMF_ENVIRONMENT).toBe('');
  });
});
