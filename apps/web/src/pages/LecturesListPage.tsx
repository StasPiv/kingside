/**
 * KS-3962 / ADR-119 §8 эпик A. Корневой экран раздела «Лекции»
 * по маршруту `/lectures`. На этом шаге — заглушка-каркас.
 * Полноценное наполнение (список «Мои лекции» через
 * `GET /my/lectures` из ADR-118) — эпик B, зависит от backend.
 */
export function LecturesListPage() {
  return (
    <div
      className="lectures-list-page"
      data-testid="lectures-list-page"
      style={{ padding: 16 }}
    >
      <h1>Лекции</h1>
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        Список будет добавлен в эпике B, после готовности backend-эндпоинта
        `GET /my/lectures` из ADR-118.
      </p>
    </div>
  );
}
