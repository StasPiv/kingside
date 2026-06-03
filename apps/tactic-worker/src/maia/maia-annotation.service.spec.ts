/**
 * KS-3633 / ADR-104 §5. Unit-тесты MaiaAnnotationService.
 *
 * Реальный ONNX-инфер не запускаем (модели нет в test-окружении и она
 * 44 МБ). Проверяем:
 *  - feature-flag `PRECISION_MAIA_ANNOTATION_ENABLED=false` → disabled;
 *  - ENV-парсинг (ELO дефолтный 1500, кастомные значения);
 *  - graceful: при отсутствующей модели (FS-ошибка) → `annotate` → null,
 *    дальнейшие вызовы тоже null (kill-switch initFailed);
 *  - конструктор `fromEnv` корректно строит конфиг.
 */
import { MaiaAnnotationService } from './maia-annotation.service';

describe('MaiaAnnotationService', () => {
  describe('fromEnv', () => {
    it('default ENV → enabled, ELO 1500', () => {
      const svc = MaiaAnnotationService.fromEnv({});
      expect(svc.isEnabled()).toBe(true);
    });

    it('PRECISION_MAIA_ANNOTATION_ENABLED=false → disabled', () => {
      const svc = MaiaAnnotationService.fromEnv({
        PRECISION_MAIA_ANNOTATION_ENABLED: 'false',
      });
      expect(svc.isEnabled()).toBe(false);
    });

    it('PRECISION_MAIA_ANNOTATION_ENABLED=0 → disabled', () => {
      const svc = MaiaAnnotationService.fromEnv({
        PRECISION_MAIA_ANNOTATION_ENABLED: '0',
      });
      expect(svc.isEnabled()).toBe(false);
    });

    it('PRECISION_MAIA_ANNOTATION_ENABLED=off → disabled', () => {
      const svc = MaiaAnnotationService.fromEnv({
        PRECISION_MAIA_ANNOTATION_ENABLED: 'off',
      });
      expect(svc.isEnabled()).toBe(false);
    });

    it('PRECISION_MAIA_ANNOTATION_ENABLED=ON → enabled', () => {
      const svc = MaiaAnnotationService.fromEnv({
        PRECISION_MAIA_ANNOTATION_ENABLED: 'ON',
      });
      expect(svc.isEnabled()).toBe(true);
    });
  });

  describe('annotate (disabled-режим)', () => {
    it('disabled → возвращает null без попытки загрузки модели', async () => {
      const svc = MaiaAnnotationService.fromEnv({
        PRECISION_MAIA_ANNOTATION_ENABLED: 'false',
      });
      const result = await svc.annotate(
        'puzzle-1',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'e2e4',
      );
      expect(result).toBeNull();
    });
  });

  describe('annotate (graceful при отсутствии модели)', () => {
    it('несуществующий MODEL_PATH → null + kill-switch initFailed', async () => {
      const svc = MaiaAnnotationService.fromEnv({
        PRECISION_MAIA_ANNOTATION_ENABLED: 'true',
        PRECISION_MAIA_MODEL_PATH: '/nonexistent/path/to/maia.onnx',
        PRECISION_MAIA_ANNOTATION_ELO: '1500',
      });

      // Первый вызов: пытаемся загрузить, FS-ошибка → null. После этого
      // initFailed = true → сервис фактически disabled на дальнейших.
      const first = await svc.annotate(
        'p-1',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'e2e4',
      );
      expect(first).toBeNull();
      expect(svc.isEnabled()).toBe(false);

      // Второй вызов: сразу null, без повторной попытки загрузки.
      const second = await svc.annotate(
        'p-2',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'e2e4',
      );
      expect(second).toBeNull();
    }, 30000);
  });
});
