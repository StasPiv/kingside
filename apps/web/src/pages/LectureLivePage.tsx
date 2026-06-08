/**
 * KS-3962 / ADR-119 §8 эпик A. Экран live-эфира лекции по
 * маршруту `/lectures/:id/live`. На этом шаге — заглушка-каркас.
 * Полноценная навигация (получить лекцию по id, отправить
 * пользователя на публичный URL трансляции `/live/:slug` или на
 * экран «недоступно», если эфир уже закрыт) — в задачах
 * следующего шага эпика A.
 */
import { useParams } from 'react-router-dom';

export function LectureLivePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div
      className="lecture-live-page"
      data-testid="lecture-live-page"
      style={{ padding: 16 }}
    >
      <h1>Лекция: эфир</h1>
      <p data-testid="lecture-live-id">{id ?? ''}</p>
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        Маршрут готов; переход на публичный slug трансляции будет добавлен
        отдельным шагом.
      </p>
    </div>
  );
}
