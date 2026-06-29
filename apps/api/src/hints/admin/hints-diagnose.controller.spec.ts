/**
 * KS-4803. Юнит-тесты `HintsDiagnoseController.run`.
 * Guard'ы и scope проверяются в e2e — здесь только проброс полей DTO.
 */
import { HintsDiagnoseController } from './hints-diagnose.controller';

function makeController(stub: { diagnose: jest.Mock }) {
  return new HintsDiagnoseController({
    diagnose: stub.diagnose,
  } as any);
}

describe('HintsDiagnoseController.run', () => {
  it('default actorType=user когда не указан', async () => {
    const diagnose = jest.fn().mockResolvedValue({ actor: {}, states: [], limits: {} });
    const ctrl = makeController({ diagnose });
    await ctrl.run({ actorId: 'u-1' } as never);
    expect(diagnose.mock.calls[0][0]).toEqual({ type: 'user', id: 'u-1' });
    expect(diagnose.mock.calls[0][1]).toBeUndefined();
  });

  it('actorType=guest пробрасывается', async () => {
    const diagnose = jest.fn().mockResolvedValue({ actor: {}, states: [], limits: {} });
    const ctrl = makeController({ diagnose });
    await ctrl.run({ actorId: 'g-1', actorType: 'guest' } as never);
    expect(diagnose.mock.calls[0][0]).toEqual({ type: 'guest', id: 'g-1' });
  });

  it('hintId пробрасывается вторым аргументом', async () => {
    const diagnose = jest.fn().mockResolvedValue({ actor: {}, states: [], limits: {} });
    const ctrl = makeController({ diagnose });
    await ctrl.run({ actorId: 'u-1', hintId: 'h-1' } as never);
    expect(diagnose.mock.calls[0][1]).toBe('h-1');
  });

  it('возвращает результат сервиса как есть', async () => {
    const result = { actor: { type: 'user', id: 'u-1' }, states: [], limits: {} };
    const diagnose = jest.fn().mockResolvedValue(result);
    const ctrl = makeController({ diagnose });
    const r = await ctrl.run({ actorId: 'u-1' } as never);
    expect(r).toBe(result);
  });
});
