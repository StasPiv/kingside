/**
 * KS-3962 / ADR-119 §8 эпик A. Лендинг конкретной лекции по
 * маршруту `/lectures/:id`. На этом шаге — заглушка-каркас:
 * пользователь больше не попадает напрямую в плеер записи; ему
 * показывается страница, которая по статусу лекции направит на
 * нужный экран (live-эфир, воспроизведение записи, экран
 * «недоступно»).
 *
 * Полноценное наполнение (`useLectureDetail`, CTA по статусу,
 * скелетон загрузки) — KS-3963. Текущая реализация поднимает
 * id из URL и выводит минимальный плейсхолдер, чтобы маршрут
 * был валидным сразу после KS-3962.
 */
import { useParams } from 'react-router-dom';

export function LectureLandingPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div
      className="lecture-landing-page"
      data-testid="lecture-landing-page"
      style={{ padding: 16 }}
    >
      <h1>Лекция</h1>
      <p data-testid="lecture-landing-id">{id ?? ''}</p>
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        Страница лекции готовится к открытию. Содержимое появится в шаге
        KS-3963.
      </p>
    </div>
  );
}
