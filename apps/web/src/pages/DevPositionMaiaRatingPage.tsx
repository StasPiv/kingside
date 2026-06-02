/**
 * KS-3581 dev-page: визуальная проверка блока «Рейтинг позиции» в обеих
 * темах. Рендерит ту же DOM-структуру, что `PositionMaiaRatingButton`, но
 * без хука/воркера — нужны только статические разметка + классы для
 * скриншотов layout-агента (idle / done / above-range / error).
 */
import '../styles/engine.css';

export default function DevPositionMaiaRatingPage() {
  return (
    <div style={{ padding: 24, maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>KS-3581 — position-maia-rating</h2>

      <section>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>idle</div>
        <div className="position-maia-rating" data-status="idle">
          <button type="button" className="position-maia-rating__btn">
            Получить рейтинг позиции
          </button>
        </div>
      </section>

      <section>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>computing</div>
        <div className="position-maia-rating" data-status="computing">
          <button type="button" className="position-maia-rating__btn" disabled>
            Считаем рейтинг…
          </button>
        </div>
      </section>

      <section>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>done</div>
        <div className="position-maia-rating" data-status="done">
          <span className="position-maia-rating__result">Этот ход на уровне ~1100</span>
          <button
            type="button"
            className="position-maia-rating__btn position-maia-rating__btn--reset"
          >
            Ещё раз
          </button>
        </div>
      </section>

      <section>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>above-range (fallback)</div>
        <div className="position-maia-rating" data-status="above-range">
          <div className="position-maia-rating__fallback">
            <span className="position-maia-rating__fallback-title">Maia предпочитает:</span>
            <ul className="position-maia-rating__fallback-list">
              <li className="position-maia-rating__fallback-item">
                <span className="position-maia-rating__fallback-move">Nf3</span>
                <span className="position-maia-rating__fallback-sep">{' — '}</span>
                <span className="position-maia-rating__fallback-prob">42.5%</span>
              </li>
              <li className="position-maia-rating__fallback-item">
                <span className="position-maia-rating__fallback-move">e4</span>
                <span className="position-maia-rating__fallback-sep">{' — '}</span>
                <span className="position-maia-rating__fallback-prob">27.1%</span>
              </li>
              <li className="position-maia-rating__fallback-item">
                <span className="position-maia-rating__fallback-move">d4</span>
                <span className="position-maia-rating__fallback-sep">{' — '}</span>
                <span className="position-maia-rating__fallback-prob">14.8%</span>
              </li>
            </ul>
          </div>
          <button
            type="button"
            className="position-maia-rating__btn position-maia-rating__btn--reset"
          >
            Ещё раз
          </button>
        </div>
      </section>

      <section>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>error</div>
        <div className="position-maia-rating" data-status="error">
          <span className="position-maia-rating__result">Не удалось получить рейтинг</span>
          <button
            type="button"
            className="position-maia-rating__btn position-maia-rating__btn--reset"
          >
            Ещё раз
          </button>
        </div>
      </section>
    </div>
  );
}
