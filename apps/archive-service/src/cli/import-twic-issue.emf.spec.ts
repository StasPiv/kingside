/**
 * KS-1685 — якорь: CLI `import-twic-issue` НЕ инициализирует EMF.
 *
 * ADR-020 §2.5: `setup-emf-env` — side-effect модуль, который выставляет
 * `process.env.AWS_EMF_ENVIRONMENT=Local` до загрузки
 * `aws-embedded-metrics`. Его нужно импортировать ТОЛЬКО из `importer-once`
 * (Fargate one-shot), но не из `import-twic-issue` CLI — ad-hoc-импорт
 * работает с dev-машины/локальной сессии и не должен тянуть EMF-инициализацию
 * (лишние env-переменные, лишние зависимости в stdout'е оператора).
 *
 * Тест красный, если кто-то добавит `import './setup-emf-env'` в CLI:
 *   - (a) jest.mock-фабрика перехватит загрузку модуля и выставит флаг
 *     `emfSetupSpy` — assert {`not.toHaveBeenCalled()`} упадёт;
 *   - (b) проверка env-переменной подстрахует (если мок каким-то образом
 *     пропустит side-effect require).
 */

const emfSetupSpy = jest.fn();

jest.mock('../setup-emf-env', () => {
  emfSetupSpy();
  // Возвращаем корректный CJS-модуль (setup-emf-env не экспортирует
  // ничего — это чисто side-effect файл).
  return {};
});

describe('import-twic-issue — EMF invariant (ADR-020 §2.5)', () => {
  const originalEmfEnv = process.env.AWS_EMF_ENVIRONMENT;

  beforeEach(() => {
    emfSetupSpy.mockClear();
    delete process.env.AWS_EMF_ENVIRONMENT;
  });

  afterAll(() => {
    if (originalEmfEnv === undefined) {
      delete process.env.AWS_EMF_ENVIRONMENT;
    } else {
      process.env.AWS_EMF_ENVIRONMENT = originalEmfEnv;
    }
  });

  it('require CLI-модуля НЕ выполняет side-effect `setup-emf-env` (EMF не инициализируется)', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./import-twic-issue');
    });

    // (a) Мок-фабрика для `setup-emf-env` не выполнялась —
    //     значит CLI (и его транзитивные зависимости) его не импортируют.
    expect(emfSetupSpy).not.toHaveBeenCalled();

    // (b) Побочный эффект `setup-emf-env` (set `AWS_EMF_ENVIRONMENT=Local`)
    //     в process.env не наблюдается. Это вторая линия защиты —
    //     гарантирует, что даже если транзитивный импорт как-то
    //     обойдёт мок (через jest.requireActual, dynamic import), env
    //     всё равно не выставлена.
    expect(process.env.AWS_EMF_ENVIRONMENT).toBeUndefined();
  });

  it('sanity: мок-фабрика реально срабатывает, если require `../setup-emf-env` выполнен напрямую (отрицательный контроль)', () => {
    // Подтверждает, что основной тест не false-positive: при прямом
    // require модуль действительно перехватывается jest.mock.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../setup-emf-env');
    });
    expect(emfSetupSpy).toHaveBeenCalledTimes(1);
  });
});
