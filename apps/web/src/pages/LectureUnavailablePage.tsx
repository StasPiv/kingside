/**
 * KS-3962 / ADR-119 §8 эпик A. Экран «лекция недоступна» по
 * маршруту `/lectures/:id/unavailable`. На этом шаге — заглушка-
 * каркас. Полные тексты по причинам (`reason`) и кнопки —
 * KS-3964.
 */
import { useParams, useSearchParams } from 'react-router-dom';

export function LectureUnavailablePage() {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const reason = search.get('reason') ?? null;
  return (
    <div
      className="lecture-unavailable-page"
      data-testid="lecture-unavailable-page"
      style={{ padding: 16 }}
    >
      <h1>Лекция недоступна</h1>
      <p data-testid="lecture-unavailable-id">{id ?? ''}</p>
      {reason && (
        <p data-testid="lecture-unavailable-reason" style={{ opacity: 0.7 }}>
          Причина: {reason}
        </p>
      )}
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        Тексты и действия будут добавлены в шаге KS-3964.
      </p>
    </div>
  );
}
