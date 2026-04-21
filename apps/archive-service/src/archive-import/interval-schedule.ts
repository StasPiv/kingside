/**
 * MVP-парсер cron-выражения `archive_sources.schedule` в интервал
 * (миллисекунды). Полноценный cron-парсер будет добавлен в KS-158x;
 * здесь поддерживаются только две формы, остальные — fallback 60 минут.
 *
 * Поведение сохраняется 1:1 относительно прежнего `intervalFromSchedule`
 * из исторического пакета archive-importer (удалён по KS-1676, ADR-013 §5, §2.5).
 */

const FALLBACK_MS = 60 * 60 * 1000;

export function intervalFromSchedule(schedule: string | null): number {
  if (!schedule) return FALLBACK_MS;
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return FALLBACK_MS;
  const [min, hr, dom, mon, dow] = parts;

  if (hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    const m = min.match(/^\*\/(\d+)$/);
    if (m) return Math.max(1, parseInt(m[1], 10)) * 60 * 1000;
  }
  if (min === '0' && dom === '*' && mon === '*' && dow === '*') {
    const m = hr.match(/^\*\/(\d+)$/);
    if (m) return Math.max(1, parseInt(m[1], 10)) * 60 * 60 * 1000;
  }
  return FALLBACK_MS;
}
