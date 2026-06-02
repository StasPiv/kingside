/**
 * KS-3604 dev-page: визуальная проверка progress-модалки и source-link
 * под NAG auto-annotation (ADR-100). Без рантайма — статические demo для
 * скриншотов layout-агента (urls: /dev/game-review).
 */
import '../styles/gameReview.css';
import '../styles/analysis.css';

function Modal({
  title,
  current,
  total,
  state,
}: {
  title: string;
  current: number;
  total: number;
  state: 'progress' | 'error' | 'done';
}) {
  const pct = Math.round((current / total) * 100);
  const isError = state === 'error';
  return (
    <div
      className={`game-review-progress-modal-backdrop`}
      style={{ position: 'relative', inset: 'auto', padding: 12 }}
    >
      <div
        className={`game-review-progress-modal${isError ? ' game-review-progress-modal--error' : ''}`}
      >
        <div className="game-review-progress-modal__header">
          <h3 className="game-review-progress-modal__title">{title}</h3>
          <button
            type="button"
            className="game-review-progress-modal__close"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
        <p className="game-review-progress-modal__progress">
          {current} из {total} ходов · {pct}%
        </p>
        <div className="game-review-progress-modal__bar" aria-hidden="true">
          <div
            className="game-review-progress-modal__bar-fill"
            style={{ width: `${pct}%` }}
          />
        </div>
        {isError && (
          <p className="game-review-progress-modal__error">
            Stockfish не отвечает. Проверьте подключение к движку.
          </p>
        )}
        <div className="game-review-progress-modal__actions">
          {isError ? (
            <>
              <button
                type="button"
                className="game-review-progress-modal__btn game-review-progress-modal__btn--secondary"
              >
                Закрыть
              </button>
              <button
                type="button"
                className="game-review-progress-modal__btn game-review-progress-modal__btn--primary"
              >
                Попробовать снова
              </button>
            </>
          ) : (
            <button
              type="button"
              className="game-review-progress-modal__btn game-review-progress-modal__btn--secondary"
            >
              Отмена
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DevGameReviewPage() {
  return (
    <div
      style={{
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        maxWidth: 720,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 16 }}>KS-3604 — Progress modal + source-link</h2>

      <section>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
          progress (in-flight)
        </div>
        <Modal title="Разбор партии" current={17} total={42} state="progress" />
      </section>

      <section>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>error</div>
        <Modal title="Разбор партии" current={9} total={42} state="error" />
      </section>

      <section>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>source-link (enabled)</div>
        <div style={{ padding: '8px 12px' }}>
          <a className="analysis-original-link" href="#">
            <span className="analysis-original-link__icon">←</span>
            <span>Исходный анализ</span>
          </a>
        </div>
      </section>

      <section>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
          source-link (disabled — parent удалён)
        </div>
        <div style={{ padding: '8px 12px' }}>
          <span
            className="analysis-original-link analysis-original-link--disabled"
            title="Исходный анализ удалён"
          >
            <span className="analysis-original-link__icon">←</span>
            <span>Исходный анализ</span>
          </span>
        </div>
      </section>
    </div>
  );
}
