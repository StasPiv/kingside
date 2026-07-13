import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type {
  CreateNotificationChannelResponse,
  NotificationChannelDto,
  NotificationChannelsResponse,
  NotificationChannelType,
  StudyScheduleDto,
  StudyScheduleResponse,
  StudySchedulesResponse,
  UpsertStudyScheduleRequest,
} from '@kingside/shared';

/**
 * KS-4928/KS-4929 / ADR-163. Список тренировок пользователя (до 5,
 * каждая с 1..7 временными слотами) и каналы уведомлений. REST
 * (KS-4927): GET/POST/PUT/DELETE /study/schedules,
 * GET/POST/DELETE /study/channels.
 *
 * Заменяет синглтон-хук useStudySchedule (GET/PUT /study/schedule —
 * эндпоинты удалены на API). Используется вкладкой «Занятия» в
 * /settings и страницей /study (empty-состояние «нет тренировок»).
 */
export function useStudySchedules() {
  const [schedules, setSchedules] = useState<StudyScheduleDto[]>([]);
  const [channels, setChannels] = useState<NotificationChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [sch, ch] = await Promise.all([
        api.get<StudySchedulesResponse>('/study/schedules'),
        api.get<NotificationChannelsResponse>('/study/channels'),
      ]);
      setSchedules(sch.schedules);
      setChannels(ch.channels);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createSchedule = useCallback(
    async (body: UpsertStudyScheduleRequest): Promise<StudyScheduleDto> => {
      const res = await api.post<StudyScheduleResponse>('/study/schedules', body);
      setSchedules((prev) => [...prev, res.schedule]);
      return res.schedule;
    },
    [],
  );

  const updateSchedule = useCallback(
    async (id: string, body: UpsertStudyScheduleRequest): Promise<StudyScheduleDto> => {
      const res = await api.put<StudyScheduleResponse>(`/study/schedules/${id}`, body);
      setSchedules((prev) => prev.map((s) => (s.id === id ? res.schedule : s)));
      return res.schedule;
    },
    [],
  );

  const deleteSchedule = useCallback(async (id: string): Promise<void> => {
    await api.delete<void>(`/study/schedules/${id}`);
    setSchedules((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const createChannel = useCallback(
    async (
      type: NotificationChannelType,
    ): Promise<CreateNotificationChannelResponse> => {
      const res = await api.post<CreateNotificationChannelResponse>(
        '/study/channels',
        { type },
      );
      setChannels((prev) => {
        const rest = prev.filter((c) => c.id !== res.channel.id);
        return [...rest, res.channel];
      });
      return res;
    },
    [],
  );

  const deleteChannel = useCallback(async (id: string): Promise<void> => {
    await api.delete<void>(`/study/channels/${id}`);
    setChannels((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return {
    schedules,
    channels,
    loading,
    error,
    refresh,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    createChannel,
    deleteChannel,
  };
}
