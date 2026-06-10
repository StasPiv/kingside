import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ALL_LECTURE_DISABLED_TOOLS,
  type LectureDisabledTool,
  type LectureSummary,
  type LectureVisibility,
} from '@kingside/shared';
import { api } from '../../api';
import { ApiError } from '../../ApiError';
import { LectureAccessPanel } from '../lecture/LectureAccessPanel';
import { StudentVisibilityChecklist } from '../lecture/StudentVisibilityChecklist';
import type { UserSearchItem } from '../../hooks/useUserSearch';
import { useMyLectures } from '../../hooks/useMyLectures';
import { useAuth } from '../../context/AuthContext';

/**
 * KS-3789 / ADR-113 §4 эпик 1. Модальное окно «Создать новую лекцию»
 * на странице AnalysisPage автора. Запускает мгновенную live-лекцию
 * на основе уже сохранённого анализа:
 *
 *   POST /lectures { title, description, analysisId }  без scheduledAt
 *
 * Ответ backend (контракт KS-3784/KS-3785):
 *   {
 *     lecture: <Lecture>,
 *     liveAnalysis: { id, slug, url } | null
 *   }
 *
 * Поле `liveAnalysis` приходит ненулевым при immediate-live — backend
 * проходит через `LiveAnalysisService.create({ analysisId })`, в нём
 * идемпотентность по `(ownerId, analysisId)`: если у автора уже была
 * запущена обычная трансляция этого анализа, лекция будет привязана
 * к существующей сессии (slug совпадёт).
 *
 * После успеха модальное окно зовёт `onCreated(liveAnalysis)`, дальше
 * AnalysisPage сам подключает live-режим через
 * `useAnalysisLiveBroadcast.attachExistingSession` — никаких
 * дополнительных навигаций или перезагрузок не нужно.
 *
 * KS-4000. Добавлен второй сценарий — «привязать к существующей
 * запланированной лекции». В этом режиме тренер выбирает заранее
 * созданную scheduled-лекцию из списка `GET /my/lectures?status=scheduled`
 * (фильтруем по `ownerId === user.id` — backend отдаёт и лекции, в
 * которые тренер добавлен в allowlist, чужие в этом окне нам ни к
 * чему). На сабмит вместо `POST /lectures` идёт
 * `POST /lectures/:id/start` с обязательным `{analysisId}`. Заголовок,
 * описание, инструменты и видимость берутся из уже сохранённой
 * лекции — поля в модалке скрываем, чтобы тренер случайно их не
 * переписал. Запуск эфира из пустого `/lectures` («Начать»-меню)
 * в KS-4000 удалён, единственный путь старта — здесь, через анализ.
 */

export interface CreateLectureLiveSession {
  id: string;
  slug: string;
  url: string;
}

interface CreateLectureResponse {
  lecture: { id: string; title: string };
  liveAnalysis: CreateLectureLiveSession | null;
}

/**
 * KS-4000. Ответ `POST /lectures/:id/start` — тот же `liveAnalysis`,
 * что и при immediate-live из POST /lectures. Backend (`LecturesService
 * .start`) теперь требует `analysisId` в теле: без него 400.
 */
interface StartLectureResponse {
  lecture: { id: string; title: string };
  liveAnalysis: CreateLectureLiveSession | null;
  serverNow?: string;
}

interface CreateLectureModalProps {
  analysisId: string;
  /** Стартовый title — берём analysisTitle, чтобы автору не пришлось перепечатывать. */
  defaultTitle?: string;
  onClose: () => void;
  /**
   * Колбэк с сессией трансляции и id созданной лекции; вызывается до
   * закрытия модального окна. `lectureId` нужен `AnalysisPage`, чтобы
   * подключить компактный значок записи (KS-3869) без асинхронной
   * выборки по slug-у — иначе `useLectureAudioPublisher.start()` не
   * успевает запуститься до первого `MediaRecorder.ondataavailable`,
   * и чанки никуда не отправляются.
   */
  onCreated: (
    session: CreateLectureLiveSession,
    lectureId: string,
  ) => void;
}

/**
 * KS-4000. Локальный формат пункта выпадающего списка scheduled-
 * лекций. Держим строкой со scheduledAt — отдельный `<option>`
 * без вложенных DOM-узлов, чтобы select оставался нативным.
 */
function formatScheduledOption(lecture: LectureSummary, locale?: string): string {
  if (!lecture.scheduledAt) return lecture.title;
  const d = new Date(lecture.scheduledAt);
  if (Number.isNaN(d.getTime())) return lecture.title;
  const when = d.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${lecture.title} — ${when}`;
}

export function CreateLectureModal({
  analysisId,
  defaultTitle,
  onClose,
  onCreated,
}: CreateLectureModalProps) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [title, setTitle] = useState<string>(defaultTitle ?? '');
  const [description, setDescription] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * KS-4000. `null` — режим «создать новую лекцию» (immediate-live,
   * прежний путь POST /lectures). Непустая строка — id выбранной
   * запланированной лекции, в этом режиме на сабмит идёт
   * POST /lectures/:id/start. Дефолт `null`, чтобы старый поток
   * (создание новой лекции из анализа) сохранил поведение.
   */
  const [boundLectureId, setBoundLectureId] = useState<string | null>(null);

  /**
   * KS-3911 / ADR-117 B01. UI хранит «разрешённые» (отмеченные галочкой)
   * инструменты, чтобы дефолт совпадал с UX-ожиданием тренера: открыл
   * модалку — все галочки стоят, все доступно. На отправку инвертируем
   * в `disabledTools` через `ALL_LECTURE_DISABLED_TOOLS.filter`.
   */
  const [enabledTools, setEnabledTools] = useState<LectureDisabledTool[]>(
    () => [...ALL_LECTURE_DISABLED_TOOLS],
  );
  /**
   * KS-4045. Жалоба пользователя: в окне «Начать лекцию» не было
   * флажка «Скрыть метрики у учеников». В KS-4040 он добавлен только в
   * `LectureSettingsModal` (редактирование существующей лекции). Здесь
   * тренер задаёт настройки при immediate-live из анализа — нужен тот
   * же контроль до старта. Контракт `CreateLectureDto.hideMetricsTab`
   * есть с KS-4039.
   */
  const [hideMetricsTab, setHideMetricsTab] = useState<boolean>(false);
  /**
   * KS-3973 / ADR-119 §8 эпик C (C04). Visibility лекции, выбирается
   * через `LectureAccessPanel` в compact-режиме (allowlist скрыт,
   * пока лекция не создана). Дефолт — `'public'`, как и в backend
   * по умолчанию. При выбранном `'restricted'` лекция создаётся
   * сразу с пустым allowlist'ом — тренер откроет настройки лекции
   * и добавит пользователей через тот же `LectureAccessPanel`
   * (уже с `lectureId`, см. KS-3974).
   */
  const [visibility, setVisibility] =
    useState<LectureVisibility>('public');
  /**
   * KS-3997 / KS-3934. Локальный буфер выбранных учеников до
   * создания лекции — отправляется в POST как `initialAccessUserIds`.
   * Виден только при `visibility === 'restricted'`; при переключении
   * на public/unlisted очищается (см. effect ниже), чтобы тренер
   * случайно не отправил лишних id с публичной лекцией.
   */
  const [pendingUsers, setPendingUsers] = useState<UserSearchItem[]>([]);
  useEffect(() => {
    if (visibility !== 'restricted' && pendingUsers.length > 0) {
      setPendingUsers([]);
    }
  }, [visibility, pendingUsers.length]);

  /**
   * KS-4000. Список scheduled-лекций тренера для выпадающего меню
   * «привязать к запланированной». Берём ограничение 50 — больше
   * не помещается в одно меню, и в реальной практике у автора их
   * не бывает столько. Если станет проблемой — выведем отдельную
   * страницу выбора.
   */
  const { items: scheduledLectures, loading: scheduledLoading } =
    useMyLectures({ status: 'scheduled', limit: 50 });

  /**
   * KS-4000 / KS-3999. Из ответа `useMyLectures` отбрасываем allowlist-
   * лекции (`ownerId !== user.id`) — управлять чужой лекцией тренер
   * не может, а в выпадашке такие пункты только сбивают. На случай
   * гостя (auth ещё не загрузился) показываем пустой список — не
   * блокируем модалку, режим «Создать новую» доступен всегда.
   */
  const ownScheduledLectures = useMemo(() => {
    if (!user) return [];
    return scheduledLectures.filter((l) => l.ownerId === user.id);
  }, [scheduledLectures, user]);

  /**
   * KS-4000. Найденная по id привязанная лекция — нужна, чтобы
   * показать её мета-инфо в режиме «привязать», без отдельного
   * запроса `GET /lectures/:id`. Список и так загружен.
   */
  const boundLecture = useMemo(() => {
    if (!boundLectureId) return null;
    return ownScheduledLectures.find((l) => l.id === boundLectureId) ?? null;
  }, [ownScheduledLectures, boundLectureId]);

  /**
   * KS-4000. Если выбранная привязка пропала из списка (например,
   * тренер удалил/отменил её в другой вкладке за время, пока модалка
   * висит) — сбрасываем выбор обратно на «Создать новую», чтобы при
   * сабмите не уйти на 404 в `POST /lectures/:id/start`.
   */
  useEffect(() => {
    if (boundLectureId && !boundLecture && !scheduledLoading) {
      setBoundLectureId(null);
    }
  }, [boundLectureId, boundLecture, scheduledLoading]);

  const toggleTool = (tool: LectureDisabledTool) => {
    setEnabledTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool],
    );
  };

  const trimmedTitle = title.trim();
  /**
   * KS-4000. В режиме привязки заголовок не требуется (берётся из
   * существующей лекции), поэтому валидация на пустой title работает
   * только в режиме «создать новую».
   */
  const submitDisabled =
    submitting ||
    (boundLectureId === null && trimmedTitle.length === 0) ||
    (boundLectureId !== null && boundLecture === null);

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      if (boundLectureId && boundLecture) {
        /**
         * KS-4000. Режим «привязать к запланированной». Backend ждёт
         * `POST /lectures/:id/start` с обязательным `analysisId` —
         * без него вернёт 400. Никакие другие поля редактировать
         * нельзя, иначе они затрут уже сохранённые значения лекции
         * (заголовок/описание/инструменты/visibility).
         */
        const resp = await api.post<StartLectureResponse>(
          `/lectures/${encodeURIComponent(boundLectureId)}/start`,
          { analysisId },
        );
        if (!resp.liveAnalysis) {
          setError(
            t(
              'lecture.create.missingLiveSession',
              'The lecture was created, but no live session was returned. Please try again.',
            ),
          );
          return;
        }
        onCreated(resp.liveAnalysis, resp.lecture.id);
        onClose();
        return;
      }

      // KS-3911 / ADR-117 B01. UI хранит «разрешённые» инструменты;
      // backend ждёт ИНВЕРСНЫЙ список — «отключённые». Считаем как
      // разность whitelist'а и текущего набора галочек: всё что не
      // отмечено — попадает в `disabledTools`. Поле отправляем всегда,
      // даже если массив пуст (=== все инструменты разрешены), чтобы
      // backend не догадывался по отсутствию ключа.
      const disabledTools: LectureDisabledTool[] = ALL_LECTURE_DISABLED_TOOLS
        .filter((tool) => !enabledTools.includes(tool));
      const resp = await api.post<CreateLectureResponse>('/lectures', {
        title: trimmedTitle,
        // Описание опциональное; пустую строку backend не ждёт — отправляем
        // поле только если автор что-то ввёл.
        ...(description.trim() ? { description: description.trim() } : {}),
        analysisId,
        disabledTools,
        // KS-4045. Новое поле `CreateLectureDto.hideMetricsTab` (KS-4039).
        // Шлём всегда — DB-default `false`, но фронт обязан передать
        // явное значение, иначе случайный refetch контракта в фоне
        // нивелировал бы выбор тренера.
        hideMetricsTab,
        // KS-3973 / ADR-119 C04. visibility отправляем всегда —
        // backend по умолчанию ставит `public`, но при выборе
        // тренером `unlisted`/`restricted` модалка обязана
        // передать значение явно, иначе лекция уйдёт публичной.
        visibility,
        // KS-3997 / KS-3934. При restricted-видимости передаём
        // выбранных учеников одним списком — backend сделает
        // bulk INSERT в `lecture_access_grants`. На других вариантах
        // visibility поле не отправляем (буфер выше всегда пуст).
        ...(visibility === 'restricted' && pendingUsers.length > 0
          ? { initialAccessUserIds: pendingUsers.map((u) => u.id) }
          : {}),
      });
      if (!resp.liveAnalysis) {
        // Контракт обещает ненулевой liveAnalysis для immediate-live
        // (без scheduledAt). Защитная ветка на случай поломки контракта —
        // показываем ошибку, не молчим.
        setError(
          t(
            'lecture.create.missingLiveSession',
            'The lecture was created, but no live session was returned. Please try again.',
          ),
        );
        return;
      }
      onCreated(resp.liveAnalysis, resp.lecture.id);
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError(
          t('lecture.create.failed', 'Failed to start the lecture. Please try again.'),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 460 }}
        data-testid="create-lecture-modal"
      >
        <div className="modal-header">
          <h2>{t('lecture.create.title', 'Start a new lecture')}</h2>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>
            ×
          </button>
        </div>

        <div className="import-form">
          {/* KS-4000. Селект «Привязать к запланированной лекции».
              Виден всегда, даже если у тренера нет ни одной scheduled —
              в этом случае показываем единственный пункт «Создать
              новую», чтобы UI не мигал при загрузке списка. */}
          <div
            className="import-field"
            data-testid="create-lecture-bind-section"
          >
            <label htmlFor="create-lecture-bind">
              {t('lecture.create.bindLabel', 'Bind to scheduled lecture')}
            </label>
            <select
              id="create-lecture-bind"
              data-testid="create-lecture-bind-select"
              value={boundLectureId ?? ''}
              onChange={(e) => setBoundLectureId(e.target.value || null)}
              disabled={submitting || scheduledLoading}
            >
              <option value="">
                {t('lecture.create.bindNew', 'Create a new lecture')}
              </option>
              {ownScheduledLectures.map((l) => (
                <option
                  key={l.id}
                  value={l.id}
                  data-testid={`create-lecture-bind-option-${l.id}`}
                >
                  {formatScheduledOption(l, i18n.language)}
                </option>
              ))}
            </select>
            {boundLecture && (
              <div
                data-testid="create-lecture-bind-info"
                style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}
              >
                {t(
                  'lecture.create.bindHint',
                  'The chosen lecture will go live with this analysis. Title, description, tools and access stay as configured.',
                )}
              </div>
            )}
          </div>

          {/* KS-4000. Поля заголовка/описания/инструментов/доступа
              скрываем при выборе существующей лекции — они уже
              заданы при её создании. Если тренеру нужно их изменить,
              он делает это через «Настройки» из списка лекций
              (KS-3974). */}
          {boundLectureId === null && (
            <>
              <div className="import-field">
                <label htmlFor="create-lecture-title">
                  {t('lecture.create.fieldTitle', 'Title')}
                </label>
                <input
                  id="create-lecture-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('lecture.create.titlePlaceholder', 'e.g. Caro-Kann for beginners')}
                  maxLength={200}
                  disabled={submitting}
                  autoFocus
                />
              </div>

              <div className="import-field">
                <label htmlFor="create-lecture-description">
                  {t('lecture.create.fieldDescription', 'Description')}
                  <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 'normal' }}>
                    {t('common.optional', 'optional')}
                  </span>
                </label>
                <textarea
                  id="create-lecture-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t(
                    'lecture.create.descriptionPlaceholder',
                    'Short summary visible to viewers.',
                  )}
                  rows={4}
                  maxLength={2000}
                  disabled={submitting}
                  style={{ resize: 'vertical', minHeight: 80 }}
                />
              </div>

              {/* KS-4047. Единый список из 5 пунктов «Что видят ученики»
                  (ИИ / Движок / База партий / Метрики; пункт «Ходы» ждёт
                  расширения enum в shared — отдельная задача backend).
                  Семантика: галочка стоит → блок виден ученику. Маппинг
                  UI → DTO сделан внутри компонента. Мёртвые пункты
                  (`analyze_game`/`generate_puzzle`/`find_by_position`)
                  не показываются, но при сохранении не теряются — для
                  лекций, у которых они были выставлены до KS-4047. */}
              <div
                className="import-field"
                data-testid="create-lecture-tools-section"
              >
                <label style={{ marginBottom: 6 }}>
                  {t(
                    'studentVisibility.sectionLabel',
                    'What students see',
                  )}
                </label>
                <StudentVisibilityChecklist
                  value={{
                    disabledTools: ALL_LECTURE_DISABLED_TOOLS.filter(
                      (tool) => !enabledTools.includes(tool),
                    ),
                    hideMetricsTab,
                  }}
                  onChange={(next) => {
                    setEnabledTools(
                      ALL_LECTURE_DISABLED_TOOLS.filter(
                        (tool) => !next.disabledTools.includes(tool),
                      ),
                    );
                    setHideMetricsTab(next.hideMetricsTab);
                  }}
                  disabled={submitting}
                  testIdPrefix="create-lecture-visibility"
                />
              </div>

              {/* KS-3973 / ADR-119 C04 + KS-3997. Секция «Кто видит эту
                  лекцию». Лекция ещё не создана; при выборе
                  `restricted` рендерим pending-allowlist — поиск +
                  чипы локального буфера. На POST уходит
                  `initialAccessUserIds` (KS-3934). */}
              <div
                className="import-field"
                data-testid="create-lecture-access-section"
              >
                <LectureAccessPanel
                  lectureId={null}
                  visibility={visibility}
                  onVisibilityChange={setVisibility}
                  disabled={submitting}
                  pendingUsers={pendingUsers}
                  onPendingUsersChange={setPendingUsers}
                />
              </div>
            </>
          )}

          {error && (
            <div className="error" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}

          <button
            className="import-btn"
            onClick={() => void handleSubmit()}
            disabled={submitDisabled}
            style={{ marginTop: 12 }}
          >
            {submitting
              ? t('common.loading', 'Loading…')
              : t('lecture.create.submit', 'Start lecture')}
          </button>
        </div>
      </div>
    </div>
  );
}
