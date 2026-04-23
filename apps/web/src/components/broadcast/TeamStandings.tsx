import { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { CrosstablePlayer, CrosstableTeam } from '@kingside/shared';

/**
 * KS-1739 / ADR-023 §2.11 (A15) — командные турниры (team-swiss / team-round-robin).
 *
 * Две зоны:
 *   1. Таблица команд (rank / name / points). Каждая строка — кликабельный
 *      тогл, раскрывающий секцию с составом команды.
 *   2. Раскрытая секция: список игроков команды (отфильтрованы через
 *      `CrosstablePlayer.team === CrosstableTeamEntry.name` с нормализацией
 *      пробелами/регистром), их персональная статистика (title / name /
 *      federation / elo / points / gamesPlayed).
 *
 * Expand/collapse через локальный `Set<string>` — не ломает identity других
 * строк, React не перерендерит все `<tr>` (state сосредоточен в родителе
 * и каждая дочерняя строка проверяет принадлежность по name).
 */
export interface TeamStandingsProps {
  data: CrosstableTeam;
  broadcastId: string;
  broadcastTitle?: string;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export function TeamStandings({ data }: TeamStandingsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((teamName: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(teamName)) next.delete(teamName);
      else next.add(teamName);
      return next;
    });
  }, []);

  const byTeam = useMemo<Map<string, CrosstablePlayer[]>>(() => {
    const map = new Map<string, CrosstablePlayer[]>();
    for (const p of data.players) {
      if (!p.team) continue;
      const key = normalize(p.team);
      const arr = map.get(key) ?? [];
      arr.push(p);
      map.set(key, arr);
    }
    // Сортируем каждую команду по rank, чтобы «board 1» был первым.
    for (const [, arr] of map) arr.sort((a, b) => a.rank - b.rank);
    return map;
  }, [data.players]);

  if (data.teams.length === 0) {
    return (
      <p className="broadcast-tab-empty" data-testid="team-standings-empty">
        {t('broadcast.noStandings', 'Standings not available yet')}
      </p>
    );
  }

  return (
    <div
      className="broadcast-xt-scroll broadcast-xt-scroll--team"
      data-testid="team-standings"
    >
      <table className="broadcast-xt-table broadcast-xt-team-table">
        <thead>
          <tr>
            <th className="broadcast-xt-th-rank" aria-label="toggle" />
            <th className="broadcast-xt-th-rank">#</th>
            <th className="broadcast-xt-th-name">{t('broadcast.crosstable.team', 'Team')}</th>
            <th className="broadcast-xt-th-num">{t('broadcast.crosstable.points', 'Pts')}</th>
          </tr>
        </thead>
        <tbody>
          {data.teams.map((team) => {
            const isOpen = expanded.has(team.name);
            const members = byTeam.get(normalize(team.name)) ?? [];
            return (
              <TeamRow
                key={team.name}
                team={team}
                members={members}
                isOpen={isOpen}
                onToggle={toggle}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface TeamRowProps {
  team: CrosstableTeam['teams'][number];
  members: CrosstablePlayer[];
  isOpen: boolean;
  onToggle: (teamName: string) => void;
}

function TeamRow({ team, members, isOpen, onToggle }: TeamRowProps) {
  const { t } = useTranslation();
  const hasMembers = members.length > 0;
  const canToggle = hasMembers;
  return (
    <>
      <tr
        className={`broadcast-xt-team-row${isOpen ? ' broadcast-xt-team-row--open' : ''}`}
        data-testid={`team-row-${team.name}`}
      >
        <td className="broadcast-xt-team-toggle-cell">
          {canToggle ? (
            <button
              type="button"
              className="broadcast-xt-team-toggle"
              onClick={() => onToggle(team.name)}
              aria-expanded={isOpen}
              aria-label={
                isOpen
                  ? t('broadcast.crosstable.collapseTeam', 'Collapse team')
                  : t('broadcast.crosstable.expandTeam', 'Expand team')
              }
              data-testid={`team-toggle-${team.name}`}
            >
              {isOpen ? '−' : '+'}
            </button>
          ) : (
            <span aria-hidden="true">·</span>
          )}
        </td>
        <td className="broadcast-xt-td-rank">{team.rank}</td>
        <td className="broadcast-xt-td-name">{team.name}</td>
        <td className="broadcast-xt-td-num broadcast-xt-td-pts">{formatPoints(team.points)}</td>
      </tr>
      {isOpen && hasMembers && (
        <tr
          className="broadcast-xt-team-members-row"
          data-testid={`team-members-${team.name}`}
        >
          <td />
          <td colSpan={3} className="broadcast-xt-team-members-cell">
            <TeamMembers members={members} />
          </td>
        </tr>
      )}
    </>
  );
}

function TeamMembers({ members }: { members: CrosstablePlayer[] }) {
  const { t } = useTranslation();
  return (
    <table className="broadcast-xt-team-members-table">
      <thead>
        <tr>
          <th className="broadcast-xt-th-num">{t('broadcast.crosstable.board', 'Brd')}</th>
          <th className="broadcast-xt-th-name">{t('tournaments.player', 'Player')}</th>
          <th className="broadcast-xt-th-fed">{t('broadcast.crosstable.fed', 'Fed')}</th>
          <th className="broadcast-xt-th-num">{t('broadcast.crosstable.elo', 'Elo')}</th>
          <th className="broadcast-xt-th-num">{t('broadcast.crosstable.points', 'Pts')}</th>
          <th className="broadcast-xt-th-num">{t('broadcast.crosstable.gamesPlayed', 'GP')}</th>
        </tr>
      </thead>
      <tbody>
        {members.map((m, idx) => (
          <tr key={`${m.normalizedName}-${m.rank}`}>
            <td className="broadcast-xt-td-num">{idx + 1}</td>
            <td className="broadcast-xt-td-name">
              {m.title && <span className="broadcast-xt-title">{m.title}</span>}
              <span className="broadcast-xt-name-text">{m.name}</span>
            </td>
            <td className="broadcast-xt-td-fed">{m.federation ?? ''}</td>
            <td className="broadcast-xt-td-num">{m.elo ?? ''}</td>
            <td className="broadcast-xt-td-num">{formatPoints(m.points)}</td>
            <td className="broadcast-xt-td-num">{m.gamesPlayed}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatPoints(p: number): string {
  const whole = Math.floor(p);
  const frac = p - whole;
  if (frac === 0.5) return whole === 0 ? '½' : `${whole}½`;
  return String(p);
}
