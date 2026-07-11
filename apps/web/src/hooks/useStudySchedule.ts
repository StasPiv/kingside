import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type {
  CreateNotificationChannelResponse,
  NotificationChannelDto,
  NotificationChannelsResponse,
  NotificationChannelType,
  StudyScheduleDto,
  StudyScheduleResponse,
  UpdateStudyScheduleRequest,
} from '@kingside/shared';

/**
 * KS-4883 / ADR-160 (задача 4 из 6). Состояние расписания занятий и
 * каналов уведомлений. REST (KS-4880):
 *   GET/PUT /study/schedule, GET/POST/DELETE /study/channels.
 *
 * Используется вкладкой «Занятия» в /settings и страницей /study
 * (для empty-состояния «расписание не настроено»).
 */
export function useStudySchedule() {
  const [schedule, setSchedule] = useState<StudyScheduleDto | null>(null);
  const [channels, setChannels] = useState<NotificationChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [sch, ch] = await Promise.all([
        api.get<StudyScheduleResponse>('/study/schedule'),
        api.get<NotificationChannelsResponse>('/study/channels'),
      ]);
      setSchedule(sch.schedule);
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

  const saveSchedule = useCallback(
    async (body: UpdateStudyScheduleRequest): Promise<StudyScheduleDto> => {
      const res = await api.put<StudyScheduleResponse>('/study/schedule', body);
      // PUT всегда возвращает созданное/обновлённое расписание.
      setSchedule(res.schedule);
      return res.schedule as StudyScheduleDto;
    },
    [],
  );

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
    schedule,
    channels,
    loading,
    error,
    refresh,
    saveSchedule,
    createChannel,
    deleteChannel,
  };
}
