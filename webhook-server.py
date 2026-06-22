#!/usr/bin/env python3
"""Webhook-сервер v2.0 для локального трекера. Агенты работают как daemon-процессы."""

import json
import re
import signal
import subprocess
import os
import sys
import time
import threading
import urllib.request
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from datetime import datetime

from agent_validator import validate_outbound, format_violations


def _log_validation_reject(channel: str, agent: str, attempt: int, text: str, verdict: dict):
    """Пишет отклонённое сообщение в logs/validator-rejects.log для аудита."""
    try:
        with open(os.path.join(LOG_DIR, "validator-rejects.log"), "a") as f:
            f.write(json.dumps({
                "ts": datetime.now().isoformat(timespec="seconds"),
                "channel": channel,
                "agent": agent,
                "attempt": attempt,
                "text": text,
                "violations": verdict.get("violations", []),
            }, ensure_ascii=False) + "\n")
    except OSError:
        pass


PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
AGENT_PROJECT_DIR = "/opt/kingside"
AGENT_CLAUDE_DIR = os.path.expanduser("~/.claude")
AGENT_CLAUDE_JSON = os.path.expanduser("~/.claude.json")
LOG_DIR = os.path.join(PROJECT_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9876

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

TRACKER_URL = os.environ.get("TRACKER_URL", "http://localhost:8090")

AGENTS_DIR = os.path.join(PROJECT_DIR, ".claude", "agents")

# Volume mounts per agent — изоляция доступа к файлам проекта
_P = PROJECT_DIR
_SHARED_TMP = os.path.join(_P, ".agent-tmp")
os.makedirs(_SHARED_TMP, exist_ok=True)
_LOCKS_DIR = os.path.join(_SHARED_TMP, "locks")
os.makedirs(_LOCKS_DIR, exist_ok=True)
# Очищаем stale lock-файлы от предыдущего запуска webhook — контейнеры были убиты
for _f in os.listdir(_LOCKS_DIR):
    try:
        os.remove(os.path.join(_LOCKS_DIR, _f))
    except OSError:
        pass


def _json_with_ts(raw_or_dict):
    """Добавляет поле ts (unix-время) к JSON-строке или dict для записи в agents.log.
    Если переданная строка не JSON — возвращает её как есть (stderr, пустые строки).
    """
    now = time.time()
    if isinstance(raw_or_dict, dict):
        return json.dumps({**raw_or_dict, "ts": now}) + "\n"
    raw = raw_or_dict
    stripped = raw.strip()
    if not stripped:
        return raw
    try:
        data = json.loads(stripped)
    except (json.JSONDecodeError, ValueError):
        return raw
    if "ts" not in data:
        data["ts"] = now
    return json.dumps(data) + "\n"


def _set_busy(agent: str, task: str = ""):
    """Создаёт lock-файл — агент занят."""
    path = os.path.join(_LOCKS_DIR, f"{agent}.lock")
    with open(path, "w") as f:
        f.write(task or "busy")


def _set_idle(agent: str):
    """Удаляет lock-файл — агент свободен."""
    path = os.path.join(_LOCKS_DIR, f"{agent}.lock")
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _is_busy(agent: str) -> bool:
    return os.path.isfile(os.path.join(_LOCKS_DIR, f"{agent}.lock"))
# Базовые volumes — есть у всех агентов
_BASE_VOLUMES = [
    f"{_P}/CLAUDE.md:/project/CLAUDE.md:ro",
    f"{_P}/.claude:/project/.claude:ro",
    f"{os.path.expanduser('~/.cache/ms-playwright')}:/home/agent/.cache/ms-playwright:ro",
    f"{_SHARED_TMP}:/tmp",
    f"{_P}/tools:/project/tools:rw",
    # turbo.json нужен всем для `turbo run build/test/lint` в монорепо
    f"{_P}/turbo.json:/project/turbo.json:ro",
]

# Генерируем MCP config для агентов (один на всех, создаётся при старте webhook)
_MCP_CONFIG_PATH = os.path.join(_SHARED_TMP, "mcp-agent.json")
def _write_mcp_config():
    cfg = {
        "mcpServers": {
            "agent": {
                "command": "node",
                "args": ["/project/tools/mcp-agent.mjs"],
            }
        }
    }
    with open(_MCP_CONFIG_PATH, "w") as f:
        json.dump(cfg, f)

_write_mcp_config()

# Мапинг filesystem-ролей в volume mounts
ROLE_VOLUMES: dict[str, list[str]] = {
    # Backend-код
    "ROLE_WRITE_APPS_API":             [f"{_P}/apps/api:/project/apps/api"],
    "ROLE_WRITE_APPS_GAME_SERVICE":    [f"{_P}/apps/game-service:/project/apps/game-service"],
    "ROLE_WRITE_APPS_BROADCAST_WORKER":[f"{_P}/apps/broadcast-worker:/project/apps/broadcast-worker"],
    "ROLE_WRITE_APPS_BROADCAST_SERVICE":[f"{_P}/apps/broadcast-service:/project/apps/broadcast-service"],
    "ROLE_WRITE_APPS_ARCHIVE_SERVICE": [f"{_P}/apps/archive-service:/project/apps/archive-service"],
    "ROLE_WRITE_APPS_TACTIC_WORKER":   [f"{_P}/apps/tactic-worker:/project/apps/tactic-worker"],
    "ROLE_WRITE_APPS_PRERENDER_SERVICE":[f"{_P}/apps/prerender-service:/project/apps/prerender-service"],
    # Frontend-код
    "ROLE_WRITE_APPS_WEB":             [f"{_P}/apps/web:/project/apps/web"],
    "ROLE_WRITE_APPS_WEB_SRC":         [f"{_P}/apps/web/src:/project/apps/web/src"],
    # Packages
    "ROLE_WRITE_PACKAGES":             [f"{_P}/packages:/project/packages"],
    "ROLE_READ_PACKAGES":              [f"{_P}/packages:/project/packages:ro"],
    "ROLE_READ_PACKAGES_SHARED":       [f"{_P}/packages/shared:/project/packages/shared:ro"],
    "ROLE_READ_PACKAGES_MAIA_CORE":    [f"{_P}/packages/maia-core:/project/packages/maia-core:ro"],
    # Root-файлы
    "ROLE_WRITE_PACKAGE_JSON":         [f"{_P}/package.json:/project/package.json"],
    "ROLE_READ_PACKAGE_JSON":          [f"{_P}/package.json:/project/package.json:ro"],
    "ROLE_WRITE_PACKAGE_LOCK":         [f"{_P}/package-lock.json:/project/package-lock.json"],
    "ROLE_READ_PACKAGE_LOCK":          [f"{_P}/package-lock.json:/project/package-lock.json:ro"],
    "ROLE_READ_TSCONFIG_BASE":         [f"{_P}/tsconfig.base.json:/project/tsconfig.base.json:ro"],
    "ROLE_WRITE_JUSTFILE":             [f"{_P}/justfile:/project/justfile"],
    "ROLE_READ_DOCKER_COMPOSE":        [f"{_P}/docker-compose.yml:/project/docker-compose.yml:ro"],
    "ROLE_WRITE_DOCKER_COMPOSE":       [f"{_P}/docker-compose.yml:/project/docker-compose.yml"],
    # Scripts/docs
    "ROLE_WRITE_SCRIPTS":              [f"{_P}/scripts:/project/scripts"],
    "ROLE_READ_SCRIPTS":               [f"{_P}/scripts:/project/scripts:ro"],
    "ROLE_WRITE_DOCS":                 [f"{_P}/docs:/project/docs"],
    "ROLE_READ_DOCS":                  [f"{_P}/docs:/project/docs:ro"],
    # node_modules (ro)
    "ROLE_READ_NODE_MODULES":          [f"{_P}/node_modules:/project/node_modules:ro"],
    "ROLE_READ_APPS_API_NODE_MODULES": [f"{_P}/apps/api/node_modules:/project/apps/api/node_modules:ro"],
    "ROLE_READ_APPS_WEB":              [f"{_P}/apps/web:/project/apps/web:ro"],
    "ROLE_READ_APPS_WEB_NODE_MODULES": [f"{_P}/apps/web/node_modules:/project/apps/web/node_modules:ro"],
    # Read-only all apps / весь проект (для координатора, qa, architect)
    "ROLE_READ_APPS":                  [f"{_P}/apps:/project/apps:ro"],
    "ROLE_READ_PROJECT":               [f"{_P}:/project:ro"],
    # Внешние
    "ROLE_READ_AWS":                   [f"{os.path.expanduser('~/.aws')}:/home/agent/.aws:ro"],
}


def _get_agent_volumes(agent: str) -> list[str]:
    """Собирает volumes для агента: базовые + из ролей."""
    volumes = list(_BASE_VOLUMES)
    for role in AGENT_ROLES.get(agent, []):
        volumes.extend(ROLE_VOLUMES.get(role, []))
    return volumes


def _scope_summary(agent: str) -> tuple[list[str], list[str]]:
    """Возвращает (rw, ro) списки путей для агента."""
    volumes = _get_agent_volumes(agent)
    rw, ro = [], []
    for v in volumes:
        parts = v.split(":")
        if len(parts) < 2:
            continue
        container_path = parts[1]
        display = container_path.replace("/project/", "").replace("/home/agent/", "~/")
        if display == "/project":
            display = "(весь /project)"
        if display == "/tmp":
            rw.append("/tmp")
            continue
        if len(parts) >= 3 and parts[2] == "ro":
            ro.append(display)
        else:
            rw.append(display)
    return sorted(set(rw)), sorted(set(ro))


def _build_scope_prompt(agent: str) -> str:
    """Строит текстовое описание scope агента на основе AGENT_VOLUMES."""
    rw, ro = _scope_summary(agent)
    lines = ["## Твой scope в контейнере (автогенерация)"]
    lines.append(f"**RW (можно менять):** {', '.join(rw) or '—'}")
    lines.append(f"**RO (только читать):** {', '.join(ro) or '—'}")
    lines.append("Остальные файлы в /project недоступны. НЕ пытайся читать/писать за пределами scope — сразу сообщи координатору.")

    # Перед отправкой agent_message — прочитай логи получателя.
    # Без этого агенты шлют сообщения вслепую: дёргают занятого, дублируют
    # уже отвеченный вопрос, прерывают долгий tool_use.
    lines.append("")
    lines.append("## Перед `agent_message` — прочитай логи получателя")
    lines.append(
        "ДО вызова `agent_message({to:X, ...})` обязательно: `agent_logs({agent:X})` — "
        "посмотри что получатель делает прямо сейчас, не ответил ли уже на твой вопрос, "
        "не идёт ли у него длинный tool_use (deploy/миграция/билд), который твой "
        "message прервёт. Если работает над твоей задачей или уже ответил — НЕ шли."
    )

    # Self-pull очереди — для всех исполнителей (не координатора).
    # Без этого правила агенты завершают задачу и уходят в idle, даже
    # если у них в To Do висит ещё работа. Координатор должен раздавать
    # неназначенные задачи, но если задача УЖЕ assignee на агента —
    # он сам её берёт без ожидания agent_message.
    if agent != "coordinator":
        lines.append("")
        lines.append("## Self-pull очереди")
        lines.append(
            f"После завершения текущей задачи в том же turn'е — "
            f"`issue_search({{assignee:'{agent}', status:'todo'}})`. "
            f"Найдено — выбери самую старую (или по приоритету, если выставлен), "
            f"`issue_transition({{key, id:21}})` и сразу начинай работу по ней. "
            f"Очередь пуста — отчитайся и заверши turn. "
            f"Не уходи в idle, если у тебя есть To Do на твоё имя."
        )

    # Координатор дополнительно видит scope и роли всех остальных агентов
    if agent == "coordinator":
        lines.append("")
        lines.append("## Агенты: scope и роли (учитывай при назначении задач)")
        for other in sorted(AGENT_ROLES):
            if other == "coordinator":
                continue
            other_rw, _ = _scope_summary(other)
            other_roles = AGENT_ROLES.get(other, [])
            lines.append(f"- **{other}**")
            lines.append(f"  - RW: {', '.join(other_rw) or '—'}")
            lines.append(f"  - Roles: {', '.join(other_roles) or '—'}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# AgentDaemon — долгоживущий процесс claude с stream-json I/O
# ---------------------------------------------------------------------------

class AgentDaemon:
    """Управляет долгоживущим процессом claude для одного агента."""

    def __init__(self, name: str):
        self.name = name
        self.proc: subprocess.Popen | None = None
        self.session_id: str | None = None
        self.lock = threading.Lock()
        self._reader_thread: threading.Thread | None = None
        # Статистика сессии
        self._total_cost: float = 0.0
        self._message_count: int = 0
        # Состояние ожидаемого ответа на текущее входящее сообщение
        self._current_sender: str = ""
        self._current_reply_channel: str | None = None
        self._current_replied: bool = False
        # Текст входящего сообщения, запустившего текущий turn — нужен валидатору
        # для оценки уместности ответа в контексте запроса.
        self._current_input_text: str = ""
        # Текущая активность для UI: kind in {idle,thinking,tool,writing,compacting,offline}
        self._activity: dict = {"kind": "offline", "detail": "", "ts": time.time()}
        # Буфер assistant-строк текущего turn'а для пост-валидации перед публикацией в agents.log.
        # text-blocks накапливаются в _turn_text; на result событии — валидация склейки.
        self._turn_buffer: list[str] = []
        self._turn_text: list[str] = []
        # Имена реально вызванных tool_use в текущем turn'е — для проверки
        # «слова против дела» в валидаторе.
        self._turn_tool_uses: list[str] = []
        self._validation_attempts: int = 0

    def _emit_status(self, kind: str, detail: str = ""):
        """Обновляет self._activity и пишет событие agent_status в agents.log.
        SSE-стрим подхватит и пересылает как event: status. Записываем только
        реальные изменения (kind+detail отличаются от текущего), чтобы не
        раздувать лог.
        """
        if self._activity.get("kind") == kind and self._activity.get("detail") == detail:
            return
        now = time.time()
        self._activity = {"kind": kind, "detail": detail, "ts": now}
        try:
            with open(os.path.join(LOG_DIR, "agents.log"), "a") as lf:
                lf.write(_json_with_ts({
                    "type": "agent_status",
                    "agent": self.name,
                    "kind": kind,
                    "detail": detail,
                }))
        except OSError:
            pass

    def _build_cmd(self) -> list[str]:
        volumes = _get_agent_volumes(self.name)
        cmd = [
            "docker", "run", "--rm", "-i",
            "--name", f"agent-{self.name}",
            "--network", "host",
            "-v", f"{AGENT_CLAUDE_DIR}:/home/agent/.claude",
            "-v", f"{AGENT_CLAUDE_JSON}:/home/agent/.claude.json",
            "-v", f"{LOG_DIR}:/project/logs",
            "-e", f"WEBHOOK_AUTH_TOKEN={_get_agent_token(self.name)}",
            "-e", f"AGENT_NAME={self.name}",
            "-e", f"VITE_DEV_BYPASS_SECRET={os.environ.get('VITE_DEV_BYPASS_SECRET', '')}",
            "-e", f"ELEVENLABS_API_KEY={os.environ.get('ELEVENLABS_API_KEY', '')}",
            "-e", f"KINGSIDE_BLOG_TOKEN={os.environ.get('KINGSIDE_BLOG_TOKEN', '')}",
        ]
        for v in volumes:
            cmd.extend(["-v", v])
        cmd.append("kingside-agent")
        cmd.extend([
            "-p",
            # Пин на opus-4-7: opus-4-8 (default с 2026-06-14) эмитит
            # tool-call как <invoke>-XML в текстовом блоке вместо structured
            # tool_use — Bash физически не вызывается, текст уходит в чат.
            "--model", "claude-opus-4-7",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--agent", self.name,
            "--dangerously-skip-permissions",
            "--strict-mcp-config",
            "--mcp-config", "/tmp/mcp-agent.json",
            "--append-system-prompt", _build_scope_prompt(self.name),
        ])
        return cmd

    def ensure_running(self):
        """Запускает daemon-процесс если он не запущен."""
        with self.lock:
            if self.proc and self.proc.poll() is None:
                return
            self._start()

    def _start(self):
        """Запускает процесс claude. Вызывать под self.lock."""
        log_file = os.path.join(LOG_DIR, "agents.log")
        env = os.environ.copy()
        env.pop("CLAUDECODE", None)

        cmd = self._build_cmd()

        with open(log_file, "a") as lf:
            self.proc = subprocess.Popen(
                cmd, cwd=AGENT_PROJECT_DIR, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=lf,
                start_new_session=True, text=True, bufsize=1,
            )

        self._total_cost = 0.0
        self._message_count = 0
        log(f"Daemon {self.name} запущен (PID: {self.proc.pid})")
        self._emit_status("idle")

        # Поток чтения stdout
        self._reader_thread = threading.Thread(
            target=self._read_stdout, daemon=True,
        )
        self._reader_thread.start()

    def _read_stdout(self):
        """Читает stdout daemon-процесса, логирует и ловит session_id / result.

        Пост-валидация: assistant-строки текущего turn'а с текстовым контентом
        буферизуются и не пишутся в agents.log сразу. На result-событии вся
        склейка текста валидируется через validate_outbound. ok → flush буфера.
        violation → буфер отбрасывается (UI не видит грязный текст), агенту
        отправляется корректирующее [SYSTEM]-сообщение. Лимит 3 попытки.
        """
        log_file = os.path.join(LOG_DIR, "agents.log")
        proc = self.proc

        def write_immediate(payload):
            with open(log_file, "a") as lf:
                lf.write(_json_with_ts(payload))

        def flush_buffer():
            if self._turn_buffer:
                with open(log_file, "a") as lf:
                    for buffered in self._turn_buffer:
                        lf.write(_json_with_ts(buffered))
            self._turn_buffer = []
            self._turn_text = []
            self._turn_tool_uses = []

        try:
            for line in iter(proc.stdout.readline, ""):
                line_s = line.strip()
                data = None
                if line_s:
                    try:
                        data = json.loads(line_s)
                    except (json.JSONDecodeError, ValueError):
                        data = None

                # Захватываем session_id
                if data:
                    sid = data.get("session_id")
                    if sid and sid != self.session_id:
                        self.session_id = sid
                        log(f"Daemon {self.name}: session_id={sid}")
                        _save_session(self.name, sid)
                        write_immediate({"type": "agent_init", "agent": self.name, "session_id": sid})

                # Отслеживаем tool_use: если агент вызвал agent_message/telegram_send
                # с правильным адресатом — считаем что ответ отправителю дан.
                # Параллельно обновляем UI-статус активности и копим текст для валидации.
                turn_has_text_now = False
                t = data.get("type") if data else None
                if t == "assistant":
                    msg = data.get("message") or {}
                    for c in msg.get("content") or []:
                        ct = c.get("type")
                        if ct == "thinking":
                            self._emit_status("thinking")
                        elif ct == "text":
                            self._emit_status("writing")
                            text_chunk = c.get("text", "")
                            if text_chunk.strip():
                                turn_has_text_now = True
                                self._turn_text.append(text_chunk)
                        elif ct == "tool_use":
                            tname = c.get("name", "")
                            short = tname.replace("mcp__agent__", "").replace("mcp__", "")
                            self._emit_status("tool", short)
                            # Запоминаем имя для проверки «слова против дела»
                            self._turn_tool_uses.append(short)
                            tinp = c.get("input") or {}
                            expected = self._current_reply_channel
                            if expected:
                                if tname == "mcp__agent__agent_message":
                                    if expected == f"agent:{tinp.get('to') or ''}":
                                        self._current_replied = True
                                elif tname == "mcp__agent__telegram_send":
                                    if expected == "telegram":
                                        self._current_replied = True
                elif t == "user":
                    # tool_result — вернулись в LLM, агент снова "думает"
                    msg = data.get("message") or {}
                    for c in msg.get("content") or []:
                        if c.get("type") == "tool_result":
                            self._emit_status("thinking")
                            break
                elif t == "system" and data.get("subtype") == "compact_boundary":
                    self._emit_status("compacting")

                # Буферим ТОЛЬКО строки с assistant-text. tool_use,
                # tool_result, thinking-блоки пускаем в agents.log сразу —
                # чтобы UI видел действия агента в реальном времени.
                # Текст всплывёт после result (если прошёл валидацию).
                is_result = t == "result"
                if not is_result:
                    if turn_has_text_now:
                        self._turn_buffer.append(line)
                    else:
                        write_immediate(line)
                    continue

                # === result event: валидация накопленного текста ===
                full_text = "".join(self._turn_text).strip()
                if full_text:
                    verdict = validate_outbound(
                        full_text,
                        tool_uses=list(self._turn_tool_uses),
                        user_prompt=self._current_input_text,
                    )
                else:
                    verdict = {"ok": True}

                publish = verdict.get("ok") or self._validation_attempts >= 2
                if not verdict.get("ok") and publish:
                    log(f"Daemon {self.name}: validation exhausted "
                        f"({self._validation_attempts + 1} attempts), publishing as-is")

                if publish:
                    flush_buffer()
                    write_immediate(line)
                    self._validation_attempts = 0

                    cost = data.get("total_cost_usd", 0)
                    self._total_cost += cost
                    self._message_count += 1
                    log(f"Daemon {self.name}: result (${cost:.4f}, total=${self._total_cost:.4f}, msgs={self._message_count})")

                    # Проверка обязательного ответа отправителю. Сбрасываем состояние
                    # ДО постановки корректирующего сообщения, чтобы оно само не
                    # триггернуло повторную проверку.
                    expected = self._current_reply_channel
                    replied = self._current_replied
                    sender = self._current_sender
                    self._current_sender = ""
                    self._current_reply_channel = None
                    self._current_replied = False
                    self._current_input_text = ""

                    _set_idle(self.name)
                    self._emit_status("idle")

                    if expected and not replied:
                        log(f"Daemon {self.name}: ответ не отправлен (expected={expected}, sender={sender}) — шлю корректирующее")
                        if expected.startswith("agent:"):
                            who = expected.split(":", 1)[1]
                            hint = f"вызови `agent_message(to=\"{who}\", message=..., reply_required=false)` (false — твой ответ дополнительного ответа не требует)"
                        elif expected == "telegram":
                            hint = "вызови `telegram_send(message=...)`"
                        else:
                            hint = "используй нужный tool-call"
                        self.send_message(
                            f"[SYSTEM] Ты не ответил отправителю ({sender or expected}). "
                            f"Текст в stdout до отправителя НЕ доходит — {hint}. "
                            f"Если ответ действительно не требовался, отправитель должен был указать reply_required=false.",
                            sender="system",
                            reply_channel=None,
                        )
                else:
                    # Reject: отбрасываем буфер + result-строку (turn «не состоялся»
                    # для UI), отправляем агенту корректирующее с перечнем нарушений.
                    # _current_* НЕ сбрасываем — оригинальное входящее всё ещё ждёт ответа.
                    violations_text = format_violations(verdict)
                    self._validation_attempts += 1
                    log(f"Daemon {self.name}: validation REJECTED attempt "
                        f"{self._validation_attempts}/3 — {violations_text[:200]}")
                    _log_validation_reject("agent-chat", self.name, self._validation_attempts, full_text, verdict)
                    self._turn_buffer = []
                    self._turn_text = []
                    self._turn_tool_uses = []
                    correction = (
                        f"[SYSTEM] Твой предыдущий ответ нарушил правила CLAUDE.md "
                        f"и НЕ был опубликован пользователю.\n\nНарушения:\n{violations_text}\n\n"
                        f"Перепиши ответ на исходное сообщение, соблюдая правила. "
                        f"Не извиняйся и не комментируй замечание — дай чистый переписанный ответ. "
                        f"Попытка {self._validation_attempts}/3."
                    )
                    self.send_message(correction, sender="system", reply_channel=None)

        except Exception as e:
            log(f"Daemon {self.name}: ошибка чтения stdout: {e}")
        finally:
            if proc.stdout:
                proc.stdout.close()
            self._emit_status("offline")
            log(f"Daemon {self.name}: stdout reader завершён")

    def _send_raw(self, message_json: str):
        """Отправляет JSON-строку в stdin процесса."""
        self.ensure_running()
        with self.lock:
            proc = self.proc
        if not proc or proc.poll() is not None:
            log(f"Daemon {self.name}: процесс мёртв, перезапуск")
            self.ensure_running()
            with self.lock:
                proc = self.proc

        _set_busy(self.name)
        try:
            proc.stdin.write(message_json + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            log(f"Daemon {self.name}: ошибка записи в stdin: {e}, перезапуск")
            _set_idle(self.name)
            with self.lock:
                self.proc = None
            self.ensure_running()
            # Повторная попытка
            with self.lock:
                proc = self.proc
            _set_busy(self.name)
            try:
                proc.stdin.write(message_json + "\n")
                proc.stdin.flush()
            except Exception as e2:
                log(f"Daemon {self.name}: повторная ошибка записи: {e2}")
                _set_idle(self.name)

    def send_message(self, text: str, sender: str = "", reply_channel: str | None = None):
        """Отправляет сообщение агенту СРАЗУ, прерывая текущий turn.

        Очереди нет: перед новым сообщением вызывается interrupt() — SDK прерывает
        текущий API-запрос / tool_use и начинает обработку нового user-message.

        sender          — ключ отправителя ("agent:<name>", "telegram", "web", "system", "").
        reply_channel   — если не None, reader проверит на event=result что агент вызвал
                          соответствующий tool-call ("agent:<name>" → agent_message.to=<name>,
                          "telegram" → telegram_send) и, если не вызвал, пришлёт корректирующее
                          сообщение.
        """
        self.ensure_running()
        if self.is_alive():
            self.interrupt()

        # Устанавливаем состояние ожидаемого ответа ДО отправки в stdin:
        # reader должен видеть правильный reply_channel, когда придут tool_use.
        self._current_sender = sender
        self._current_reply_channel = reply_channel
        self._current_replied = False
        self._current_input_text = text

        stream = json.dumps({
            "type": "user",
            "message": {"role": "user", "content": text},
        })
        self._send_raw(stream)
        log(f"Daemon {self.name}: сообщение отправлено (sender={sender or '-'}, reply={reply_channel or '-'})")

    def get_rss_mb(self) -> float | None:
        """Возвращает RSS памяти контейнера в MB, или None."""
        try:
            result = subprocess.run(
                ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", f"agent-{self.name}"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                mem = result.stdout.strip().split("/")[0].strip()
                if "GiB" in mem:
                    return float(mem.replace("GiB", "").strip()) * 1024
                if "MiB" in mem:
                    return float(mem.replace("MiB", "").strip())
        except Exception:
            pass
        return None

    def interrupt(self):
        """Прерывает текущий turn Claude Code через control_request в stream-json stdin.

        Контекст и session_id сохраняются — прерывается только текущий API-запрос
        или tool_use. Daemon после этого переходит в idle и готов принять следующий
        ввод из очереди.
        """
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                return False
            proc = self.proc
        req_id = f"req_interrupt_{int(time.time() * 1000)}"
        payload = json.dumps({
            "type": "control_request",
            "request_id": req_id,
            "request": {"subtype": "interrupt"},
        })
        try:
            proc.stdin.write(payload + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            log(f"Daemon {self.name}: control_request interrupt — ошибка записи в stdin: {e}")
            return False
        log(f"Daemon {self.name}: control_request interrupt отправлен (req_id={req_id})")
        return True

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self):
        """Останавливает daemon-процесс."""
        with self.lock:
            if not self.proc:
                return
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            # Останавливаем docker-контейнер
            subprocess.run(
                ["docker", "stop", f"agent-{self.name}"],
                capture_output=True, timeout=15,
            )
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                subprocess.run(
                    ["docker", "kill", f"agent-{self.name}"],
                    capture_output=True, timeout=5,
                )
                self.proc.wait()
            log(f"Daemon {self.name} остановлен (session_id={self.session_id} сохранён для resume)")
            self.proc = None
            _set_idle(self.name)
            self._emit_status("offline")


# ---------------------------------------------------------------------------
# Глобальный реестр daemon-агентов
# ---------------------------------------------------------------------------

agent_daemons: dict[str, AgentDaemon] = {}
agent_daemons_lock = threading.Lock()


SESSIONS_FILE = os.path.join(LOG_DIR, "sessions.json")
_sessions_lock = threading.Lock()


def _load_sessions() -> dict:
    """Загружает маппинг agent -> session_id из файла."""
    try:
        with open(SESSIONS_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_session(agent: str, session_id: str):
    """Сохраняет session_id для агента в файл."""
    with _sessions_lock:
        sessions = _load_sessions()
        sessions[agent] = session_id
        with open(SESSIONS_FILE, "w") as f:
            json.dump(sessions, f, indent=2)
    log(f"Сессия сохранена: {agent} -> {session_id}")


def get_daemon(agent: str) -> AgentDaemon:
    """Возвращает (или создаёт) daemon для агента."""
    with agent_daemons_lock:
        if agent not in agent_daemons:
            agent_daemons[agent] = AgentDaemon(agent)
        return agent_daemons[agent]


# ---------------------------------------------------------------------------
# Tracker helpers
# ---------------------------------------------------------------------------

def get_valid_agents():
    """Сканирует .claude/agents/ и возвращает set имён агентов."""
    agents = set()
    if os.path.isdir(AGENTS_DIR):
        for f in os.listdir(AGENTS_DIR):
            if f.endswith(".md"):
                agents.add(f[:-3])
    return agents


def _get_issue_details(key: str) -> dict:
    """Возвращает description и последние комментарии задачи из локального трекера."""
    result = {"description": "", "comments": [], "linked": []}
    try:
        # Получаем данные задачи
        req = urllib.request.Request(f"{TRACKER_URL}/api/issues/{key}")
        req.add_header("Accept", "application/json")
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read().decode())
        result["description"] = data.get("description", "") or ""
    except Exception as e:
        log(f"Ошибка получения деталей {key}: {e}")
        return result
    try:
        # Получаем комментарии
        req = urllib.request.Request(f"{TRACKER_URL}/api/issues/{key}/comments")
        req.add_header("Accept", "application/json")
        resp = urllib.request.urlopen(req, timeout=10)
        comments_raw = json.loads(resp.read().decode())[-5:]
        for c in comments_raw:
            author = c.get("author", "")
            body = c.get("body", "")
            result["comments"].append(f"{author}: {body}")
    except Exception as e:
        log(f"Ошибка получения комментариев {key}: {e}")
    return result


def _get_issue_status_category(key: str) -> str:
    """Возвращает категорию статуса задачи из локального трекера."""
    status_map = {"done": "done", "in_progress": "indeterminate", "todo": "new"}
    try:
        req = urllib.request.Request(f"{TRACKER_URL}/api/issues/{key}")
        req.add_header("Accept", "application/json")
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read().decode())
        status = data.get("status", "")
        return status_map.get(status, "")
    except Exception as e:
        log(f"Ошибка проверки статуса {key}: {e}")
        return ""




# ---------------------------------------------------------------------------
# Отправка сообщений агентам
# ---------------------------------------------------------------------------

def send_to_agent(agent: str, prompt: str, sender: str = "", reply_channel: str | None = None):
    """Отправляет сообщение daemon-агенту. Добавляет в очередь — не прерывает текущее."""
    daemon = get_daemon(agent)
    daemon.ensure_running()
    daemon.send_message(prompt, sender=sender, reply_channel=reply_channel)


def handle_agent_message(handler, payload):
    """Обрабатывает POST /agent/message — прямое сообщение между агентами.

    Сообщение всегда кладётся в Redis-очередь target-агента. Если target сейчас
    занят — worker-loop сам обработает сообщение после освобождения (FIFO).
    """
    sender = payload.get("from", "")
    target = payload.get("to", "")
    message = payload.get("message", "")

    if not target or not message:
        handler.send_response(400)
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": "missing 'to' or 'message'"}).encode())
        return

    if "reply_required" not in payload or not isinstance(payload["reply_required"], bool):
        handler.send_response(400)
        handler.end_headers()
        handler.wfile.write(json.dumps({
            "error": "'reply_required' is required and must be boolean (true | false)",
        }).encode())
        return
    reply_required = payload["reply_required"]

    valid_agents = get_valid_agents()
    if target not in valid_agents:
        handler.send_response(404)
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": f"unknown agent '{target}'"}).encode())
        return

    # Префикс делает явным контракт ответа — без этого target не отличает
    # «вопрос/задача» от «ACK/уведомление» и часто отвечает на ACK → пинг-понг.
    if sender:
        tag = "нужен ответ" if reply_required else "ACK"
        prefix = f"[from {sender} · {tag}] "
    else:
        prefix = ""
    sender_tag = f"agent:{sender}" if sender else ""
    reply_channel = f"agent:{sender}" if (sender and reply_required) else None

    # send_to_agent → send_message делает interrupt + stdin.write синхронно.
    send_to_agent(target, f"{prefix}{message}", sender=sender_tag, reply_channel=reply_channel)
    log(f"Agent message: {sender or '?'} -> {target} ({len(message)} chars, reply_required={reply_required})")

    handler.send_response(200)
    handler.end_headers()
    handler.wfile.write(json.dumps({
        "status": "sent",
        "to": target,
        "reply_required": reply_required,
    }).encode())


def _escape_html(text: str) -> str:
    """Экранирует HTML-символы для Telegram API."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _wrap_markdown_tables(text: str) -> str:
    """Заворачивает блоки markdown-таблиц в ```<code>``` — Telegram не рендерит таблицы."""
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        # Начало таблицы: строка с `|` на обоих концах
        if lines[i].lstrip().startswith("|") and lines[i].rstrip().endswith("|"):
            block = []
            while i < len(lines) and lines[i].lstrip().startswith("|") and lines[i].rstrip().endswith("|"):
                block.append(lines[i])
                i += 1
            if len(block) >= 2:
                out.append("```")
                out.extend(block)
                out.append("```")
            else:
                out.extend(block)
        else:
            out.append(lines[i])
            i += 1
    return "\n".join(out)


def handle_telegram_send(handler, payload):
    """Обрабатывает POST /telegram/send — агент отправляет сообщение в Telegram (Markdown)."""
    message = payload.get("message", "")
    if not message:
        handler.send_response(400)
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": "missing 'message'"}).encode())
        return

    verdict = validate_outbound(message)
    if not verdict.get("ok"):
        violations_text = format_violations(verdict)
        log(f"Telegram send REJECTED by validator: {message[:80]} | {violations_text[:200]}")
        _log_validation_reject("telegram", payload.get("agent", "?"), 1, message, verdict)
        handler.send_response(422)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        handler.wfile.write(json.dumps({
            "error": "validation_failed",
            "message": (
                "Сообщение нарушает правила CLAUDE.md и в Telegram не отправлено. "
                "Перепиши и вызови telegram_send снова.\n\nНарушения:\n" + violations_text
            ),
            "violations": verdict.get("violations", []),
        }, ensure_ascii=False).encode())
        return

    # Таблицы Telegram не рендерит — оборачиваем в моноширинный блок
    message = _wrap_markdown_tables(message)
    send_telegram(message, parse_mode="Markdown")
    log(f"Telegram send: {message[:80]}")

    handler.send_response(200)
    handler.end_headers()
    handler.wfile.write(json.dumps({"status": "sent"}).encode())


FEEDBACK_WEBHOOK_SECRET = os.environ.get("FEEDBACK_WEBHOOK_SECRET", "")
WEBHOOK_AUTH_TOKEN = os.environ.get("WEBHOOK_AUTH_TOKEN", "")

import hmac as _hmac
import hashlib as _hashlib


def _sign_token(roles: list[str]) -> str:
    """Формат токена: <ROLE1,ROLE2,...>.<hmac16>. Подпись — HMAC-SHA256 секретом WEBHOOK_AUTH_TOKEN."""
    payload = ",".join(sorted(roles))
    sig = _hmac.new(WEBHOOK_AUTH_TOKEN.encode(), payload.encode(), _hashlib.sha256).hexdigest()[:16]
    return f"{payload}.{sig}"


def _parse_token(token: str) -> list[str] | None:
    """Возвращает список ролей если подпись валидна, иначе None."""
    if not token or "." not in token:
        return None
    payload, sig = token.rsplit(".", 1)
    expected = _hmac.new(WEBHOOK_AUTH_TOKEN.encode(), payload.encode(), _hashlib.sha256).hexdigest()[:16]
    if not _hmac.compare_digest(sig, expected):
        return None
    return [r for r in payload.split(",") if r]


# Роли агентов (ROLE_*, UPPERCASE).
# Роли бывают двух видов: действия (COMMIT, DEPLOY_*, NPM_INSTALL, API_START, UP) и файловые (READ_*/WRITE_*).
AGENT_ROLES: dict[str, list[str]] = {
    "backend": [
        "ROLE_READ_PROJECT",
        # действия
        "ROLE_COMMIT", "ROLE_GIT_READ", "ROLE_DEPLOY_API",
        "ROLE_DEPLOY_GAME_SERVICE", "ROLE_DEPLOY_BROADCAST_SERVICE",
        "ROLE_DEPLOY_ARCHIVE_SERVICE", "ROLE_DEPLOY_TACTIC_WORKER",
        "ROLE_DEPLOY_PRERENDER_SERVICE",
        "ROLE_DEPLOY_WORKERS", "ROLE_NPM_INSTALL", "ROLE_NPM_RUN", "ROLE_API_START",
        # файлы
        "ROLE_WRITE_APPS_API", "ROLE_WRITE_APPS_GAME_SERVICE",
        "ROLE_WRITE_APPS_BROADCAST_WORKER", "ROLE_WRITE_APPS_BROADCAST_SERVICE",
        "ROLE_WRITE_APPS_ARCHIVE_SERVICE",
        "ROLE_WRITE_APPS_TACTIC_WORKER", "ROLE_WRITE_APPS_PRERENDER_SERVICE",
        "ROLE_WRITE_PACKAGES", "ROLE_WRITE_PACKAGE_JSON", "ROLE_WRITE_PACKAGE_LOCK",
        "ROLE_READ_TSCONFIG_BASE", "ROLE_READ_NODE_MODULES",
        "ROLE_READ_APPS_API_NODE_MODULES",
        "ROLE_READ_DOCS",
    ],
    "frontend": [
        "ROLE_READ_PROJECT",
        "ROLE_COMMIT", "ROLE_GIT_READ", "ROLE_DEPLOY_FRONTEND", "ROLE_NPM_INSTALL", "ROLE_NPM_RUN", "ROLE_API_START",
        "ROLE_WRITE_APPS_WEB", "ROLE_READ_PACKAGES_SHARED", "ROLE_READ_PACKAGES_MAIA_CORE",
        "ROLE_READ_PACKAGE_JSON", "ROLE_READ_TSCONFIG_BASE",
        "ROLE_READ_NODE_MODULES", "ROLE_READ_APPS_WEB_NODE_MODULES",
        "ROLE_READ_SCRIPTS",
    ],
    "layout": [
        "ROLE_READ_PROJECT",
        "ROLE_COMMIT", "ROLE_GIT_READ", "ROLE_DEPLOY_FRONTEND", "ROLE_NPM_RUN", "ROLE_API_START",
        "ROLE_WRITE_APPS_WEB_SRC",
        "ROLE_READ_PACKAGE_JSON", "ROLE_READ_TSCONFIG_BASE",
        "ROLE_READ_NODE_MODULES", "ROLE_READ_APPS_WEB_NODE_MODULES",
        "ROLE_READ_SCRIPTS",
    ],
    "devops": [
        "ROLE_READ_PROJECT",
        "ROLE_COMMIT", "ROLE_GIT_READ", "ROLE_DEPLOY_FRONTEND", "ROLE_DEPLOY_API",
        "ROLE_DEPLOY_GAME_SERVICE", "ROLE_DEPLOY_BROADCAST_SERVICE",
        "ROLE_DEPLOY_ARCHIVE_SERVICE", "ROLE_DEPLOY_TACTIC_WORKER",
        "ROLE_DEPLOY_PRERENDER_SERVICE",
        "ROLE_DEPLOY_WORKERS",
        "ROLE_DEPLOY_ALL", "ROLE_NPM_INSTALL", "ROLE_NPM_RUN", "ROLE_API_START", "ROLE_UP",
        "ROLE_DOCKER_COMPOSE",
        "ROLE_WRITE_SCRIPTS", "ROLE_READ_DOCS", "ROLE_WRITE_DOCKER_COMPOSE",
        "ROLE_WRITE_PACKAGE_JSON", "ROLE_WRITE_JUSTFILE", "ROLE_READ_AWS",
    ],
    "architect": [
        "ROLE_READ_PROJECT",
        "ROLE_COMMIT", "ROLE_GIT_READ",
        "ROLE_READ_APPS", "ROLE_READ_PACKAGES", "ROLE_WRITE_DOCS",
    ],
    "marketing": [
        "ROLE_READ_PROJECT",
        "ROLE_COMMIT", "ROLE_GIT_READ", "ROLE_DEPLOY_FRONTEND",
        "ROLE_READ_APPS_WEB",
    ],
    "coordinator": [
        "ROLE_READ_PROJECT",
        "ROLE_GIT_READ",
        "ROLE_READ_APPS", "ROLE_READ_PACKAGES", "ROLE_READ_DOCS",
        "ROLE_READ_NODE_MODULES", "ROLE_READ_APPS_WEB_NODE_MODULES",
        "ROLE_READ_PACKAGE_JSON", "ROLE_READ_PACKAGE_LOCK", "ROLE_READ_TSCONFIG_BASE",
    ],
    "qa": [
        "ROLE_GIT_READ", "ROLE_READ_PROJECT",
    ],
    "content": [
        # Контент-инженер: RO весь проект (для запуска утилит и чтения схем),
        # CLI-заливка уроков (npm run import:lesson). /tmp монтируется базово.
        # Без COMMIT — контент в git не идёт (copyright).
        "ROLE_GIT_READ", "ROLE_READ_PROJECT", "ROLE_NPM_RUN",
        # Видеообзоры сайта (tools/video-overview/, Playwright + Silero/ElevenLabs):
        # tools/ уже RW базово, нужен бинарь playwright из /project/node_modules
        # и api_start чтобы поднять локальный сервер для записи сценариев.
        "ROLE_READ_NODE_MODULES", "ROLE_API_START",
    ],
}

# Все роли — для главного токена пользователя
_ALL_ROLES = sorted({r for roles in AGENT_ROLES.values() for r in roles})


def _get_agent_token(agent: str) -> str:
    """Возвращает токен с ролями агента."""
    return _sign_token(AGENT_ROLES.get(agent, []))


# Какая роль нужна для endpoint (scope -> role)
ENDPOINT_ROLE: dict[str, object] = {
    "/commit": "ROLE_COMMIT",
    "/npm-install": "ROLE_NPM_INSTALL",
    "/api-start": "ROLE_API_START",
    "/up": "ROLE_UP",
    "/docker-compose": "ROLE_DOCKER_COMPOSE",
    "/npm-run": "ROLE_NPM_RUN",
    "/vite-start": "ROLE_API_START",
    "/git-log": "ROLE_GIT_READ",
    # Должно совпадать с case-блоком в scripts/deploy-aws.sh:
    # frontend | api | game-service | broadcast-service | archive-service |
    # tactic-worker | workers | prerender-service | synthetic-bot | all | "" (auto-detect)
    # archive-service образ kingside-archive-service также используется
    # для task-def kingside-archive-importer-{oneshot,adhoc} (см. scripts/deploy-aws.sh:48-54).
    "/deploy": {
        "frontend": "ROLE_DEPLOY_FRONTEND",
        "api": "ROLE_DEPLOY_API",
        "game-service": "ROLE_DEPLOY_GAME_SERVICE",
        "broadcast-service": "ROLE_DEPLOY_BROADCAST_SERVICE",
        "archive-service": "ROLE_DEPLOY_ARCHIVE_SERVICE",
        "tactic-worker": "ROLE_DEPLOY_TACTIC_WORKER",
        "prerender-service": "ROLE_DEPLOY_PRERENDER_SERVICE",
        "workers": "ROLE_DEPLOY_WORKERS",
        "all": "ROLE_DEPLOY_ALL",
        "": "ROLE_DEPLOY_ALL",
    },
}

DOCKER_COMPOSE_ALLOWED = {"build", "up", "down", "logs", "ps", "config", "restart"}
NPM_RUN_ALLOWED = {"build", "test", "lint", "prisma:generate", "prisma:migrate"}


def handle_feedback_notify(handler):
    """Обрабатывает POST /feedback/notify — уведомление о новом фидбеке."""
    # Проверка секретного ключа
    if FEEDBACK_WEBHOOK_SECRET:
        secret = handler.headers.get("X-Feedback-Secret", "")
        if secret != FEEDBACK_WEBHOOK_SECRET:
            handler.send_response(403)
            handler.send_header("Content-Type", "application/json")
            handler.end_headers()
            handler.wfile.write(json.dumps({"error": "forbidden"}).encode())
            return

    content_length = int(handler.headers.get("Content-Length", 0))
    body = handler.rfile.read(content_length)
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        handler.send_response(400)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": "invalid json"}).encode())
        return

    title = payload.get("title", "")
    author = payload.get("author", "")
    feedback_id = payload.get("id", "")
    message = payload.get("message", "")
    payload_type = payload.get("type", "")

    if payload_type == "comment":
        feedback_id = payload.get("feedbackId", "")
        msg = f'[from feedback] New comment on "{title}" by {author}: {message} (ID: {feedback_id})'
    else:
        msg = f"[from feedback] New feedback: {title} by {author}: {message} (ID: {feedback_id})"
    log(f"Feedback notify: {msg}")
    send_to_agent("coordinator", msg)

    handler.send_response(200)
    handler.send_header("Content-Type", "application/json")
    handler.end_headers()
    handler.wfile.write(json.dumps({"ok": True}).encode())


AI_CHAT_TIMEOUT = 900
AI_CHAT_IDLE_TTL = 600  # 10 minutes
MAX_CHAT_DAEMONS = 10
MCP_SERVER_PATH = os.path.join(PROJECT_DIR, "tools", "mcp-kingside.mjs")

# Список allowedTools для Claude CLI собирается динамически из каталога API
# `GET /_mcp/tools` (ADR-061). Кэшируется на CATALOG_CACHE_TTL секунд, чтобы
# не делать запрос при каждом старте даймона.
CATALOG_CACHE_TTL = 600  # 10 minutes
_mcp_tool_names_cache: tuple[float, list[str]] | None = None


def _fetch_mcp_tool_names() -> list[str]:
    """Тянет каталог /_mcp/tools и возвращает список имён `mcp__kingside__<name>`."""
    global _mcp_tool_names_cache
    now = time.time()
    if _mcp_tool_names_cache and now - _mcp_tool_names_cache[0] < CATALOG_CACHE_TTL:
        return _mcp_tool_names_cache[1]
    api_url = os.environ.get("KINGSIDE_API_URL", "http://localhost:3001").rstrip("/")
    headers = {}
    key = os.environ.get("MCP_DISCOVERY_KEY", "")
    if key:
        headers["X-Mcp-Discovery-Key"] = key
    try:
        req = urllib.request.Request(f"{api_url}/_mcp/tools", headers=headers)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        names = [f"mcp__kingside__{t['name']}" for t in data.get("tools", [])]
        _mcp_tool_names_cache = (now, names)
        return names
    except Exception as e:
        log(f"_fetch_mcp_tool_names failed: {e}")
        # Возвращаем кэш если есть, иначе пустой список (модель не сможет
        # дёрнуть MCP, но не упадёт)
        return _mcp_tool_names_cache[1] if _mcp_tool_names_cache else []


def _build_mcp_config(user_id, user_token=""):
    """Build temporary MCP config JSON for Claude CLI with user-specific env."""
    api_url = os.environ.get("KINGSIDE_API_URL", "http://localhost:3001")
    return {
        "mcpServers": {
            "kingside": {
                "command": "node",
                "args": [MCP_SERVER_PATH],
                "env": {
                    "KINGSIDE_USER_ID": user_id,
                    "KINGSIDE_USER_TOKEN": user_token,
                    "KINGSIDE_API_URL": api_url,
                },
            }
        }
    }


# ---------------------------------------------------------------------------
# ChatDaemon — долгоживущий процесс claude для AI-чата (один на пользователя)
# ---------------------------------------------------------------------------

chat_daemons: dict[str, "ChatDaemon"] = {}
chat_daemons_lock = threading.Lock()
# Хранит session_id Claude CLI для каждого user_id. Переживает перезапуски ChatDaemon,
# чтобы после timeout/idle новый процесс мог продолжить через --resume.
chat_session_ids: dict[str, str] = {}


class ChatDaemon:
    """Daemon claude CLI для одного пользователя чата."""

    def __init__(self, user_id: str, user_token: str = "", resume_session_id: str | None = None, no_mcp: bool = False):
        self.user_id = user_id
        self.user_token = user_token
        self.no_mcp = no_mcp
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()
        self._reader_thread: threading.Thread | None = None
        self._last_activity = time.time()
        self._mcp_config_path: str | None = None
        # session_id для --resume при следующем старте. Берётся из system/init event.
        self._resume_session_id: str | None = resume_session_id
        # Для синхронного ожидания ответа
        self._response_text = ""
        self._response_ready = threading.Event()
        self._collecting = False

    def _name_suffix(self) -> str:
        return "nomcp" if self.no_mcp else "mcp"

    def _build_cmd(self, system_prompt: str = "") -> list[str]:
        cmd = [
            "docker", "run", "--rm", "-i",
            "--name", f"chat-{self.user_id[:8]}-{self._name_suffix()}",
            "--network", "host",
            "-v", f"{AGENT_CLAUDE_DIR}:/home/agent/.claude",
            "-v", f"{AGENT_CLAUDE_JSON}:/home/agent/.claude.json",
        ]
        if self._mcp_config_path:
            cmd.extend(["-v", f"{self._mcp_config_path}:{self._mcp_config_path}:ro"])
            cmd.extend(["-v", f"{MCP_SERVER_PATH}:{MCP_SERVER_PATH}:ro"])
        cmd.extend([
            "kingside-agent",
            "-p",
            "--model", "claude-opus-4-7",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--strict-mcp-config",
        ])
        if self._resume_session_id:
            cmd.extend(["--resume", self._resume_session_id])
        if self._mcp_config_path:
            cmd.extend(["--mcp-config", self._mcp_config_path])
            allowed = _fetch_mcp_tool_names()
            if allowed:
                cmd.extend(["--allowedTools"] + allowed)
        if system_prompt:
            cmd.extend(["--system-prompt", system_prompt])
        return cmd

    def start(self, system_prompt: str = ""):
        """Запускает daemon-процесс claude."""
        if self.no_mcp:
            # MCP отключён — никаких тулов, фоновый daemon только для генерации
            # текстовых ответов (например, комментирование позиций в review).
            self._mcp_config_path = None
        else:
            # Создаём MCP config
            mcp_config = _build_mcp_config(self.user_id, self.user_token)
            self._mcp_config_path = f"/tmp/mcp-chat-{self.user_id[:8]}.json"
            with open(self._mcp_config_path, "w") as f:
                json.dump(mcp_config, f)

        env = os.environ.copy()
        env.pop("CLAUDECODE", None)
        cmd = self._build_cmd(system_prompt)

        log_file = os.path.join(LOG_DIR, "agents.log")
        with open(log_file, "a") as lf:
            self.proc = subprocess.Popen(
                cmd, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=lf,
                start_new_session=True, text=True, bufsize=1,
            )

        self._last_activity = time.time()
        log(f"ChatDaemon {self.user_id[:8]}: started (PID: {self.proc.pid})")

        self._reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader_thread.start()

    def _read_stdout(self):
        """Читает stream-json stdout, собирает текстовый ответ."""
        proc = self.proc
        log_path = os.path.join(LOG_DIR, f"chat-daemon-{self.user_id[:8]}.log")
        try:
            stream_log = open(log_path, "a", buffering=1)
        except OSError:
            stream_log = None
        try:
            for line in iter(proc.stdout.readline, ""):
                line_s = line.strip()
                if not line_s:
                    continue
                if stream_log:
                    stream_log.write(f"[{time.strftime('%H:%M:%S')}] {line_s}\n")
                try:
                    data = json.loads(line_s)
                except (json.JSONDecodeError, ValueError):
                    continue

                msg_type = data.get("type", "")

                # Запоминаем session_id для будущего --resume
                if msg_type == "system" and data.get("subtype") == "init":
                    sid = data.get("session_id")
                    if sid:
                        self._resume_session_id = sid
                        chat_session_ids[_chat_daemon_key(self.user_id, self.no_mcp)] = sid

                # Собираем текстовые блоки ответа
                if msg_type == "assistant" and self._collecting:
                    message = data.get("message", {})
                    for block in message.get("content", []):
                        if block.get("type") == "text":
                            self._response_text += block.get("text", "")

                # result означает конец обработки
                if msg_type == "result":
                    result_text = data.get("result", "")
                    if result_text and not self._response_text:
                        self._response_text = result_text
                    cost = data.get("total_cost_usd", 0)
                    log(f"ChatDaemon {self.user_id[:8]}: result (${cost:.4f}), len={len(self._response_text)}")
                    self._collecting = False
                    self._response_ready.set()

        except Exception as e:
            log(f"ChatDaemon {self.user_id[:8]}: reader error: {e}")
        finally:
            if proc.stdout:
                proc.stdout.close()
            if stream_log:
                try:
                    stream_log.close()
                except OSError:
                    pass
            log(f"ChatDaemon {self.user_id[:8]}: reader done")
            # Signal waiting callers
            self._response_ready.set()

    def send_and_wait(self, message: str, timeout: float = AI_CHAT_TIMEOUT) -> str | None:
        """Отправляет сообщение и ждёт ответа. Возвращает текст или None при таймауте.

        Сериализуется через self.lock: один turn на daemon одновременно.
        Без сериализации параллельные вызовы делили _response_text/_response_ready
        и все возвращали ответ на первое сообщение (KS-3714).
        """
        if not self.proc or self.proc.poll() is not None:
            return None

        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                return None

            self._response_text = ""
            self._response_ready.clear()
            self._collecting = True
            self._last_activity = time.time()

            msg_json = json.dumps({
                "type": "user",
                "message": {"role": "user", "content": message},
            })

            try:
                self.proc.stdin.write(msg_json + "\n")
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError) as e:
                log(f"ChatDaemon {self.user_id[:8]}: write error: {e}")
                self._collecting = False
                return None

            if self._response_ready.wait(timeout=timeout):
                self._last_activity = time.time()
                return self._response_text
            else:
                log(f"ChatDaemon {self.user_id[:8]}: timeout ({timeout}s)")
                self._collecting = False
                return None

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def is_idle(self) -> bool:
        return time.time() - self._last_activity > AI_CHAT_IDLE_TTL

    def stop(self):
        """Останавливает daemon."""
        with self.lock:
            if not self.proc:
                return
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            subprocess.run(
                ["docker", "stop", f"chat-{self.user_id[:8]}-{self._name_suffix()}"],
                capture_output=True, timeout=10,
            )
            try:
                self.proc.wait(timeout=5)
            except Exception:
                subprocess.run(
                    ["docker", "kill", f"chat-{self.user_id[:8]}-{self._name_suffix()}"],
                    capture_output=True, timeout=5,
                )
            self.proc = None
        if self._mcp_config_path:
            try:
                os.unlink(self._mcp_config_path)
            except Exception:
                pass
        log(f"ChatDaemon {self.user_id[:8]}: stopped")


def _chat_daemon_cleanup_loop():
    """Фоновый поток: убивает idle chat daemons каждые 60 сек."""
    while True:
        time.sleep(60)
        to_remove = []
        with chat_daemons_lock:
            for uid, daemon in chat_daemons.items():
                if not daemon.is_alive() or daemon.is_idle():
                    to_remove.append(uid)
            for uid in to_remove:
                daemon = chat_daemons.pop(uid)
                daemon.stop()
        if to_remove:
            log(f"ChatDaemon cleanup: removed {len(to_remove)} idle daemons")


def _chat_daemon_key(user_id: str, no_mcp: bool) -> str:
    """Ключ chat_daemons: разделяем daemon'ы с MCP и без — у них разные cmd/контейнеры."""
    return f"{user_id}#nomcp" if no_mcp else user_id


def _get_or_create_chat_daemon(user_id: str, user_token: str, system_prompt: str, no_mcp: bool = False) -> ChatDaemon | None:
    """Возвращает существующий daemon или создаёт новый. None если лимит достигнут."""
    key = _chat_daemon_key(user_id, no_mcp)
    with chat_daemons_lock:
        daemon = chat_daemons.get(key)
        if daemon and daemon.is_alive():
            return daemon
        # Убираем мёртвый daemon
        if daemon:
            daemon.stop()
            del chat_daemons[key]
        # Очищаем мёртвые daemons перед проверкой лимита
        dead = [k for k, d in chat_daemons.items() if not d.is_alive()]
        for k in dead:
            chat_daemons.pop(k).stop()
        # Отказ если лимит достигнут
        if len(chat_daemons) >= MAX_CHAT_DAEMONS:
            log(f"ChatDaemon limit reached ({MAX_CHAT_DAEMONS}), rejecting {user_id[:8]}")
            return None
        # Создаём новый (с резюме предыдущей сессии, если есть)
        resume_sid = chat_session_ids.get(key)
        daemon = ChatDaemon(user_id, user_token, resume_session_id=resume_sid, no_mcp=no_mcp)
        daemon.start(system_prompt)
        chat_daemons[key] = daemon
        return daemon


def handle_ai_chat(handler):
    """Обрабатывает POST /ai-chat — daemon на каждого пользователя."""
    content_length = int(handler.headers.get("Content-Length", 0))
    body = handler.rfile.read(content_length)
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        handler.send_response(400)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": "invalid json"}).encode())
        return

    message = payload.get("message", "").strip()
    system_prompt = payload.get("systemPrompt", "").strip()
    user_id = payload.get("userId", "")
    user_token = payload.get("userToken", "")
    no_mcp = bool(payload.get("noMcp", False))

    if not message:
        handler.send_response(400)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": "missing message"}).encode())
        return

    if not user_id:
        handler.send_response(400)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": "missing userId"}).encode())
        return

    log(f"AI chat: msg={message[:80]}, userId={user_id[:8]}{' [noMcp]' if no_mcp else ''}")

    try:
        daemon = _get_or_create_chat_daemon(user_id, user_token, system_prompt, no_mcp=no_mcp)
        if daemon is None:
            handler.send_response(429)
            handler.send_header("Content-Type", "application/json")
            handler.end_headers()
            handler.wfile.write(json.dumps({
                "error": "Все слоты AI-ассистента заняты, попробуйте позже"
            }).encode())
            return

        response_text = daemon.send_and_wait(message, timeout=AI_CHAT_TIMEOUT)

        if response_text is None:
            # Daemon died or timeout — kill and retry once
            log(f"AI chat: daemon failed for {user_id[:8]}, retrying")
            key = _chat_daemon_key(user_id, no_mcp)
            with chat_daemons_lock:
                old = chat_daemons.pop(key, None)
                if old:
                    old.stop()
            daemon = _get_or_create_chat_daemon(user_id, user_token, system_prompt, no_mcp=no_mcp)
            if daemon is None:
                handler.send_response(429)
                handler.send_header("Content-Type", "application/json")
                handler.end_headers()
                handler.wfile.write(json.dumps({
                    "error": "Все слоты AI-ассистента заняты, попробуйте позже"
                }).encode())
                return
            response_text = daemon.send_and_wait(message, timeout=AI_CHAT_TIMEOUT)

        if response_text is None:
            handler.send_response(504)
            handler.send_header("Content-Type", "application/json")
            handler.end_headers()
            handler.wfile.write(json.dumps({"error": "timeout"}).encode())
            return

        log(f"AI chat response: {response_text[:100]}")
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        handler.wfile.write(json.dumps({"response": response_text}).encode())

    except Exception as e:
        log(f"AI chat exception: {e}")
        handler.send_response(500)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": str(e)}).encode())


def launch_agent(key, summary, agent, prompt=None):
    """Формирует промпт и отправляет его daemon-агенту."""
    if not prompt:
        role = agent.upper()
        prompt = (
            f"Ты работаешь над задачей {key}: {summary}\n"
            f"Общайся и думай на русском языке.\n"
            f"Рабочая директория: /project\n"
            f"ЕСЛИ ОКРУЖЕНИЕ НЕ РАБОТАЕТ (dev-сервер, API, CORS, auth, модули) — НЕМЕДЛЕННО ПРЕКРАТИ РАБОТУ. "
            f"Добавь комментарий 'Окружение не готово: <проблема>. @coordinator' и ЗАВЕРШИ. Не пытайся чинить.\n\n"
            f"1. Переведи задачу в статус 'In Progress' (transitionId: 21)\n"
            f"2. Прочитай описание задачи\n"
            f"3. Выполни задачу\n"
            f"4. Коммитни изменения через /commit endpoint\n"
            f"5. Добавь комментарий с результатом\n"
            f"6. Переведи задачу в статус 'Done' (transitionId: 41)"
        )

    log_file = os.path.join(LOG_DIR, "agents.log")
    with open(log_file, "a") as lf:
        lf.write(_json_with_ts({"type": "agent_msg", "agent": agent.upper(), "task": key}))

    send_to_agent(agent, prompt)
    log(f"Сообщение отправлено daemon {agent} для {key}")


# ---------------------------------------------------------------------------
# Telegram / Tracker helpers
# ---------------------------------------------------------------------------

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with open(os.path.join(LOG_DIR, "webhook.log"), "a") as f:
        f.write(line + "\n")


def _split_message(text, max_len=4096):
    """Разбивает текст на части не длиннее max_len, по границе строки."""
    if len(text) <= max_len:
        return [text]
    parts = []
    while text:
        if len(text) <= max_len:
            parts.append(text)
            break
        split_pos = text.rfind("\n", 0, max_len)
        if split_pos <= 0:
            split_pos = max_len
        parts.append(text[:split_pos])
        text = text[split_pos:].lstrip("\n")
    return parts


def send_telegram(text, parse_mode="Markdown"):
    """Отправляет сообщение в Telegram. parse_mode: Markdown | HTML | MarkdownV2."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    for part in _split_message(text):
        data = urllib.parse.urlencode({
            "chat_id": TELEGRAM_CHAT_ID,
            "text": part,
            "parse_mode": parse_mode,
            "disable_web_page_preview": "true",
        }).encode()
        try:
            req = urllib.request.Request(url, data=data)
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            log(f"Ошибка отправки в Telegram: {e}")


def _md_escape(text: str) -> str:
    """Экранирует спецсимволы Telegram Markdown v1 (`*`, `_`, `[`, `` ` ``)."""
    return text.replace("\\", "\\\\").replace("*", "\\*").replace("_", "\\_").replace("[", "\\[").replace("`", "\\`")


def format_telegram_issue(event_type, payload):
    """Форматирует событие трекера в HTML для Telegram.
    Возвращает tuple (text, parse_mode) или None.
    HTML вместо Markdown v1: устойчивее к спецсимволам в summary/comment_body —
    Markdown v1 валит парсинг на `[`/`]` и др. (HTTP 400 от Telegram API)."""
    issue = payload.get("issue", {})
    key = _escape_html(issue.get("key", payload.get("issue_key", "?")))
    summary = _escape_html(issue.get("summary", ""))
    status = _escape_html(issue.get("status", ""))
    assignee = _escape_html(issue.get("assignee", "не назначен") or "не назначен")

    if event_type == "issue_created":
        return (
            f"🆕 <b>Создана задача</b>\n"
            f"{key}: {summary}\n"
            f"Статус: {status}\n"
            f"Исполнитель: {assignee}",
            "HTML",
        )

    if event_type == "issue_updated":
        return (
            f"✏️ <b>Обновлена задача</b>\n"
            f"{key}: {summary}\n"
            f"Статус: {status}\n"
            f"Исполнитель: {assignee}",
            "HTML",
        )

    if event_type == "issue_transitioned":
        return (
            f"🔄 <b>Смена статуса</b>\n"
            f"{key}: {summary}\n"
            f"Статус: {status}",
            "HTML",
        )

    if event_type == "comment_added":
        comment = payload.get("comment", {})
        comment_author = _escape_html(comment.get("author", ""))
        comment_body = _escape_html(comment.get("body", ""))
        return (
            f"💬 <b>Новый комментарий</b>\n"
            f"{key}: {summary}\n"
            f"Автор: {comment_author}\n"
            f"{comment_body}",
            "HTML",
        )

    return None


def add_tracker_comment(issue_key, text):
    """Добавляет комментарий в задачу через API локального трекера."""
    url = f"{TRACKER_URL}/api/issues/{issue_key}/comments"
    body = json.dumps({"author": "system", "body": text}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")

    try:
        resp = urllib.request.urlopen(req, timeout=15)
        log(f"Комментарий добавлен в {issue_key} (HTTP {resp.status})")
        return True
    except Exception as e:
        log(f"Ошибка добавления комментария в {issue_key}: {e}")
        return False


def telegram_poll_loop():
    """Поллинг Telegram getUpdates — пересылает сообщения агентам."""
    if not TELEGRAM_BOT_TOKEN:
        log("Telegram polling: TELEGRAM_BOT_TOKEN не задан, поллинг отключён")
        return

    offset = 0
    poll_url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates"
    log("Telegram polling запущен")

    while True:
        params = urllib.parse.urlencode({
            "offset": offset,
            "timeout": 30,
            "allowed_updates": json.dumps(["message"]),
        })
        try:
            req = urllib.request.Request(f"{poll_url}?{params}")
            resp = urllib.request.urlopen(req, timeout=60)
            data = json.loads(resp.read().decode())
        except Exception as e:
            log(f"Telegram polling ошибка: {e}")
            time.sleep(5)
            continue

        if not data.get("ok"):
            time.sleep(5)
            continue

        for update in data.get("result", []):
            offset = update["update_id"] + 1
            message = update.get("message", {})
            text = message.get("text", "") or message.get("caption", "")
            photos = message.get("photo") or []
            document = message.get("document") or {}
            chat = message.get("chat", {})
            chat_id = str(chat.get("id", ""))
            from_user = message.get("from", {})
            username = from_user.get("username", "")
            first_name = from_user.get("first_name", "")
            display = f"@{username}" if username else first_name

            # Принимаем сообщение если есть текст, фото или image-документ
            doc_is_image = isinstance(document, dict) and (document.get("mime_type") or "").startswith("image/")
            if not text and not photos and not doc_is_image:
                continue

            if TELEGRAM_CHAT_ID and chat_id != TELEGRAM_CHAT_ID:
                continue

            # Скачиваем картинки в /tmp/telegram/<update_id>_<n>.<ext>.
            # _SHARED_TMP смонтирован в контейнерах как /tmp, путь
            # /tmp/telegram/... агент откроет через Read.
            saved_paths = []
            if photos or doc_is_image:
                tg_dir_host = os.path.join(_SHARED_TMP, "telegram")
                os.makedirs(tg_dir_host, exist_ok=True)
                files_to_fetch = []
                if photos:
                    # Telegram присылает массив PhotoSize по возрастанию размера — берём максимальный
                    largest = photos[-1]
                    files_to_fetch.append((largest.get("file_id"), "jpg"))
                if doc_is_image:
                    mime = document.get("mime_type", "image/jpeg")
                    ext = mime.split("/", 1)[-1].split(";")[0].strip() or "bin"
                    files_to_fetch.append((document.get("file_id"), ext))
                for idx, (file_id, ext) in enumerate(files_to_fetch):
                    if not file_id:
                        continue
                    try:
                        # 1) getFile -> file_path
                        gf = urllib.request.Request(
                            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getFile?file_id={urllib.parse.quote(file_id)}"
                        )
                        gf_resp = urllib.request.urlopen(gf, timeout=30)
                        gf_data = json.loads(gf_resp.read().decode())
                        if not gf_data.get("ok"):
                            log(f"Telegram getFile failed: {gf_data}")
                            continue
                        file_path = gf_data["result"]["file_path"]
                        # 2) скачиваем содержимое
                        dl = urllib.request.urlopen(
                            f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}",
                            timeout=60,
                        )
                        host_path = os.path.join(tg_dir_host, f"{update['update_id']}_{idx}.{ext}")
                        with open(host_path, "wb") as f:
                            f.write(dl.read())
                        agent_path = f"/tmp/telegram/{update['update_id']}_{idx}.{ext}"
                        saved_paths.append(agent_path)
                    except Exception as e:
                        log(f"Telegram скачивание файла не удалось: {e}")

            log(f"Telegram сообщение от {display}: {text[:100] or '(без текста)'}{f' [+{len(saved_paths)} файл(ов)]' if saved_paths else ''}")

            # Определяем целевого агента: @agent в начале или coordinator по умолчанию
            valid_agents = get_valid_agents()
            target_agent = "coordinator"
            agent_msg = text
            match = re.match(r"^@(\w+)\s+", text)
            if match and match.group(1).lower() in valid_agents:
                target_agent = match.group(1).lower()
                agent_msg = text[match.end():]

            prompt_text = f"[Telegram {display}] {agent_msg}".rstrip()
            if saved_paths:
                files_block = "\n".join(f"- {p}" for p in saved_paths)
                prompt_text = (
                    f"{prompt_text}\n\nПрикреплённые файлы (открой через Read):\n{files_block}"
                ).strip()
            _log_user_prompt(target_agent, prompt_text, source=f"Telegram {display}")
            send_to_agent(target_agent, prompt_text, sender="telegram", reply_channel="telegram")
            log(f"Telegram -> {target_agent}: {agent_msg[:80]} (files={len(saved_paths)})")
            ack = f"✅ Сообщение отправлено агенту {target_agent}"
            if saved_paths:
                ack += f" (+{len(saved_paths)} файл)"
            send_telegram(ack)


def coordinator_cron_loop():
    """Каждые 7 минут пинает координатора проверить доску.
    - Шлёт промпт только если daemon координатора жив и не занят (busy lock).
    - Если координатор offline — НЕ поднимаем сами (иначе каждые 7 мин будет
      новая сессия). Жив, но busy — пропускаем тик до следующего раза.
    Живёт как фоновый thread webhook-сервера — переживает рестарты webhook.
    """
    interval = 7 * 60
    prompt = (
        "[CRON] Проверь задачи в статусе `To Do` и `In Progress`: "
        "не зависли ли (нет активности от исполнителя, нет комментариев, "
        "есть блокеры). Зависшие — подпинай ответственного через "
        "`agent_message` или поставь блокирующий тикет. Если всё в порядке "
        "— короткий ACK, без действий."
    )
    log("Coordinator cron запущен (интервал 7 мин)")
    while True:
        time.sleep(interval)
        try:
            with agent_daemons_lock:
                d = agent_daemons.get("coordinator")
            if not d or not d.proc or d.proc.poll() is not None:
                continue
            if _is_busy("coordinator"):
                continue
            _log_user_prompt("coordinator", prompt, source="cron")
            send_to_agent("coordinator", prompt, sender="system", reply_channel=None)
            log("Coordinator cron: промпт отправлен")
        except Exception as e:
            log(f"Coordinator cron error: {e}")


def _log_user_prompt(agent: str, text: str, source: str = "web"):
    """Записывает пользовательский промпт в agents.log для отображения в /logs."""
    log_file = os.path.join(LOG_DIR, "agents.log")
    with open(log_file, "a") as lf:
        lf.write(_json_with_ts({
            "type": "user_prompt",
            "agent": agent,
            "text": text,
            "source": source,
        }))


# ---------------------------------------------------------------------------
# Webhook handler
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Веб-интерфейс логов (SSE + HTML)
# ---------------------------------------------------------------------------

AGENT_COLORS = {
    "COORDINATOR": "#f0a",
    "FRONTEND": "#0cf",
    "BACKEND": "#f80",
    "LAYOUT": "#bf0",
    "DEVOPS": "#f55",
    "QA": "#fa0",
    "ARCHITECT": "#a8f",
}


def _agent_color(name: str) -> str:
    return AGENT_COLORS.get(name.upper(), "#888")


def _format_tool_use(tname: str, inp: dict) -> str:
    """Форматирует tool_use в читаемый HTML в зависимости от типа инструмента."""

    if tname == "Bash":
        cmd = inp.get("command", "")
        desc = inp.get("description", "")
        parts = '<span class="tool-name">$</span>'
        if desc:
            parts += f' <span class="tool-desc">{_esc(desc)}</span>'
        parts += f'<pre class="tool-code">{_esc(cmd)}</pre>'
        return parts

    if tname == "Read":
        path = inp.get("file_path", "")
        offset = inp.get("offset", "")
        limit = inp.get("limit", "")
        extra = ""
        if offset or limit:
            extra = f' <span class="tool-meta">L{offset or 1}' + (f'-{int(offset or 0) + int(limit)}' if limit else '') + '</span>'
        return f'<span class="tool-name">Read</span> <span class="tool-path">{_esc(path)}</span>{extra}'

    if tname == "Write":
        path = inp.get("file_path", "")
        content = inp.get("content", "")
        lines = content.count("\n") + 1
        return (
            f'<span class="tool-name">Write</span> <span class="tool-path">{_esc(path)}</span>'
            f' <span class="tool-meta">{lines} lines</span>'
            f'<pre class="tool-code">{_esc(content)}</pre>'
        )

    if tname == "Edit":
        path = inp.get("file_path", "")
        old = inp.get("old_string", "")
        new = inp.get("new_string", "")
        return (
            f'<span class="tool-name">Edit</span> <span class="tool-path">{_esc(path)}</span>'
            f'<div class="diff-block">'
            f'<pre class="diff-del">{_esc(old)}</pre>'
            f'<pre class="diff-add">{_esc(new)}</pre>'
            f'</div>'
        )

    if tname == "Glob":
        pattern = inp.get("pattern", "")
        path = inp.get("path", "")
        return f'<span class="tool-name">Glob</span> <span class="tool-path">{_esc(pattern)}</span>' + (f' in {_esc(path)}' if path else '')

    if tname == "Grep":
        pattern = inp.get("pattern", "")
        path = inp.get("path", "")
        return f'<span class="tool-name">Grep</span> <code class="tool-pattern">{_esc(pattern)}</code>' + (f' in {_esc(path)}' if path else '')

    if tname.startswith("mcp__"):
        # MCP tool: показать имя коротко + параметры
        short_name = tname.split("__")[-1]
        # Тулы с длинным текстом — выводим основное содержимое полностью в блоке <pre>
        content_fields = {
            "agent_message": "message",
            "comment_add": "body",
            "telegram_send": "message",
            "issue_create": "description",
            "issue_update": "description",
        }
        content_field = content_fields.get(short_name)
        params = []
        for k, v in inp.items():
            if k == content_field:
                continue
            vs = str(v)
            if len(vs) > 100:
                vs = vs[:100] + "..."
            params.append(f'<span class="tool-param-key">{_esc(k)}</span>=<span class="tool-param-val">{_esc(vs)}</span>')
        params_html = ", ".join(params)
        if content_field is not None:
            body = str(inp.get(content_field, ""))
            sep = " " if params_html else ""
            return (
                f'<span class="tool-name">{_esc(short_name)}</span>{sep}{params_html}'
                f'<div class="tool-code text-body">{_esc(body)}</div>'
            )
        return f'<span class="tool-name">{_esc(short_name)}</span> {params_html}'

    if tname == "Agent":
        desc = inp.get("description", "")
        prompt = inp.get("prompt", "")
        agent_type = inp.get("subagent_type", "")
        header = f'<span class="tool-name">Agent</span>'
        if agent_type:
            header += f' <span class="tool-meta">{_esc(agent_type)}</span>'
        if desc:
            header += f' <span class="tool-desc">{_esc(desc)}</span>'
        if prompt:
            header += f'<pre class="tool-code">{_esc(prompt)}</pre>'
        return header

    # Fallback: generic JSON
    inp_str = json.dumps(inp, ensure_ascii=False, indent=2)
    return f'<span class="tool-name">{_esc(tname)}</span><pre class="tool-code">{_esc(inp_str)}</pre>'


def _format_log_line(data: dict, agents_map: dict, agent_sid: dict, current_task: dict) -> str | None:
    """Форматирует JSON-строку из agents.log в HTML. Возвращает None если пропустить."""
    t = data.get("type", "")
    sid = data.get("session_id", "")[:8]

    # agent_status — отдельный SSE event 'status', не лог-строка
    if t == "agent_status":
        return None

    if t == "user_prompt":
        agent = data.get("agent", "")
        text = data.get("text", "")
        source = data.get("source", "web")
        color = _agent_color(agent)
        return (
            f'<div class="ev ev-user">'
            f'<span class="badge badge-user">{_esc(source)}</span>'
            f'<span class="prompt-arrow">→</span>'
            f'<span class="badge" style="background:{color}" data-agent="{_esc(agent.lower())}">{_esc(agent.upper())}</span>'
            f'<pre class="user-text">{_esc(text)}</pre>'
            f'</div>'
        )

    if t == "agent_msg":
        agent = data.get("agent", "")
        task = data.get("task", "")
        current_task[agent.lower()] = task
        color = _agent_color(agent)
        return (
            f'<div class="ev ev-msg">'
            f'<span class="badge" style="background:{color}" data-agent="{_esc(agent.lower())}">{_esc(agent)}</span>'
            f'<span class="task">{_esc(task)}</span>'
            f'<span class="lbl">новое сообщение</span>'
            f'</div>'
        )

    if t == "agent_init":
        agent = data.get("agent", "")
        sid = data.get("session_id", "")[:8]
        agents_map[sid] = agent.upper()
        agent_sid[agent.lower()] = sid
        color = _agent_color(agent)
        return (
            f'<div class="ev ev-init">'
            f'<span class="badge" style="background:{color}" data-agent="{_esc(agent.lower())}">{_esc(agent.upper())}</span>'
            f'daemon запущен'
            f'</div>'
        )

    if t == "system" and data.get("subtype") == "init":
        if sid not in agents_map:
            agents_map[sid] = sid
        return None

    def _label_parts(s):
        name = agents_map.get(s, s)
        task = ""
        for aname, asid in agent_sid.items():
            if asid == s:
                task = current_task.get(aname, "")
                break
        return name, task

    if t == "assistant":
        msg = data.get("message", {})
        name, task = _label_parts(sid)
        color = _agent_color(name)
        parts = []
        for c in msg.get("content", []):
            ct = c.get("type", "")
            if ct == "thinking":
                text = c.get("thinking", "")
                if text:
                    parts.append(
                        f'<div class="ev ev-think">'
                        f'<span class="badge" style="background:{color}" data-agent="{_esc(name.lower())}">{_esc(name)}</span>'
                        f'{f"<span class=task>{_esc(task)}</span>" if task else ""}'
                        f'<pre class="think-text">{_esc(text)}</pre>'
                        f'</div>'
                    )
            elif ct == "text":
                text = c.get("text", "")
                if text:
                    parts.append(
                        f'<div class="ev ev-text">'
                        f'<span class="badge" style="background:{color}" data-agent="{_esc(name.lower())}">{_esc(name)}</span>'
                        f'{f"<span class=task>{_esc(task)}</span>" if task else ""}'
                        f'<span class="text-body">{_esc(text)}</span>'
                        f'</div>'
                    )
            elif ct == "tool_use":
                tname = c.get("name", "")
                inp = c.get("input", {})
                tool_html = _format_tool_use(tname, inp)
                parts.append(
                    f'<div class="ev ev-tool">'
                    f'<span class="badge" style="background:{color}" data-agent="{_esc(name.lower())}">{_esc(name)}</span>'
                    f'{f"<span class=task>{_esc(task)}</span>" if task else ""}'
                    f'{tool_html}'
                    f'</div>'
                )
            elif ct == "tool_result":
                content = c.get("content", "")
                if isinstance(content, list):
                    content = " ".join(x.get("text", "") for x in content if isinstance(x, dict))
                if content:
                    parts.append(
                        f'<div class="ev ev-tool-result">'
                        f'<span class="badge" style="background:{color}" data-agent="{_esc(name.lower())}">{_esc(name)}</span>'
                        f'<pre class="tool-code">{_esc(content)}</pre>'
                        f'</div>'
                    )
        return "\n".join(parts) if parts else None

    if t == "result":
        name, task = _label_parts(sid)
        color = _agent_color(name)
        cost = data.get("total_cost_usd", 0)
        return (
            f'<div class="ev ev-result">'
            f'<span class="badge" style="background:{color}" data-agent="{_esc(name.lower())}">{_esc(name)}</span>'
            f'{f"<span class=task>{_esc(task)}</span>" if task else ""}'
            f'<span class="cost">${cost:.4f}</span> готов'
            f'</div>'
        )

    return None


def _esc(text: str) -> str:
    """Экранирует HTML."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _inject_ts_attr(html: str, ts) -> str:
    """Вставляет data-ts="<unix_ts>" в каждый <div class="ev ...">.
    Нужно чтобы клиент при (ре)загрузке страницы показывал реальное время события,
    а не `new Date()` на момент получения SSE.
    """
    if ts is None:
        return html
    try:
        ts_f = float(ts)
    except (TypeError, ValueError):
        return html
    return re.sub(r'<div class="(ev[^"]*)"', f'<div data-ts="{ts_f}" class="\\1"', html)


def _send_status_event(wfile, payload: dict):
    """Шлёт SSE-событие типа 'status' с JSON-пейлоадом."""
    wfile.write(b"event: status\n")
    wfile.write(f"data: {json.dumps(payload)}\n\n".encode())


def _snapshot_agent_statuses() -> list[dict]:
    """Возвращает текущее состояние всех валидных агентов для UI-панели."""
    statuses = []
    valid = sorted(get_valid_agents())
    with agent_daemons_lock:
        for name in valid:
            d = agent_daemons.get(name)
            if d and d.proc and d.proc.poll() is None:
                act = dict(d._activity)
                act["alive"] = True
            else:
                act = {"kind": "offline", "detail": "", "ts": time.time(), "alive": False}
            act["agent"] = name
            statuses.append(act)
    return statuses


def _stream_logs_sse(wfile):
    """SSE-стрим: читает agents.log и шлёт форматированные события.
    Два типа сообщений:
      - default 'message' — HTML-фрагмент лога;
      - 'status' — JSON c активностью агента, для боковой панели.
    """
    log_file = os.path.join(LOG_DIR, "agents.log")
    agents_map = {}
    agent_sid_map = {}
    current_task_map = {}

    # Snapshot статусов всем агентам — клиент сразу заполнит панель
    for s in _snapshot_agent_statuses():
        try:
            _send_status_event(wfile, s)
        except (BrokenPipeError, ConnectionResetError):
            return
    try:
        wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        return

    with open(log_file, "r") as f:
        # Прочитаем весь файл для инициализации маппингов, отправим последние 100 строк
        lines = f.readlines()
        recent = lines[-200:] if len(lines) > 200 else lines

        for line in lines:
            try:
                data = json.loads(line.strip())
                # Инициализируем маппинги без вывода
                t = data.get("type", "")
                if t == "agent_init":
                    agent = data.get("agent", "")
                    sid = data.get("session_id", "")[:8]
                    agents_map[sid] = agent.upper()
                    agent_sid_map[agent.lower()] = sid
                elif t == "agent_msg":
                    agent = data.get("agent", "")
                    task = data.get("task", "")
                    current_task_map[agent.lower()] = task
            except (json.JSONDecodeError, ValueError):
                pass

        # Отправляем последние строки
        for line in recent:
            try:
                data = json.loads(line.strip())
                if data.get("type") == "agent_status":
                    continue  # snapshot уже выслан выше — старые статус-события не нужны
                formatted = _format_log_line(data, agents_map, agent_sid_map, current_task_map)
                if formatted:
                    formatted = _inject_ts_attr(formatted, data.get("ts"))
                    sse_data = "\n".join(f"data: {line}" for line in formatted.split("\n"))
                    wfile.write(f"{sse_data}\n\n".encode())
            except (json.JSONDecodeError, ValueError):
                pass
        wfile.flush()

        # Теперь tail -f
        while True:
            line = f.readline()
            if not line:
                time.sleep(0.3)
                continue
            try:
                data = json.loads(line.strip())
                # Статус-события уходят отдельным каналом, не как HTML
                if data.get("type") == "agent_status":
                    _send_status_event(wfile, {
                        "agent": data.get("agent", ""),
                        "kind": data.get("kind", "idle"),
                        "detail": data.get("detail", ""),
                        "ts": data.get("ts", time.time()),
                        "alive": data.get("kind", "idle") != "offline",
                    })
                    wfile.flush()
                    continue
                formatted = _format_log_line(data, agents_map, agent_sid_map, current_task_map)
                if formatted:
                    formatted = _inject_ts_attr(formatted, data.get("ts"))
                    sse_data = "\n".join(f"data: {line}" for line in formatted.split("\n"))
                    wfile.write(f"{sse_data}\n\n".encode())
                    wfile.flush()
            except (json.JSONDecodeError, ValueError):
                pass


LOGS_HTML = """<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kingside Agents</title>
<script>(function(){var t=localStorage.getItem('theme')||'dark';if(t==='light')document.documentElement.setAttribute('data-theme','light');})();</script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0d1117; --fg: #c9d1d9; --fg-strong: #e6edf3; --fg-muted: #8b949e; --fg-dim: #6e7681; --fg-faint: #484f58;
    --panel: #161b22; --panel-2: #1c2128; --border: #30363d; --border-dim: #21262d;
    --link: #58a6ff; --link-2: #79c0ff;
    --accent-yellow: #ffd700; --accent-green: #3fb950; --accent-red: #f85149;
    --accent-purple-text: #d2a8ff; --accent-purple-bg: #6e40c9; --accent-user-text: #e2c5ff;
    --accent-orange: #f0883e; --accent-orange-2: #ffa657; --accent-green-2: #7ee787;
    --ev-msg-bg: #1c2333; --ev-init-bg: #0d2818; --ev-think-bg: #161b22; --ev-text-bg: #161b22;
    --ev-tool-bg: #1c1e2a; --ev-tool-result-bg: #161b22; --ev-result-bg: #0d2818; --ev-user-bg: #1a1a30;
    --ev-msg-bd: #ffd700; --ev-init-bd: #00ff88; --ev-think-bd: #444; --ev-text-bd: #58a6ff;
    --ev-tool-bd: #64b5f6; --ev-tool-result-bd: #555; --ev-result-bd: #00ff88; --ev-user-bd: #a371f7;
    --code-bg: #1c2128; --tool-cmd-bg: #161b22; --tool-code-bg: #0d1117; --tool-pattern-bg: #1c1e2a;
    --diff-del-bg: #3d1117; --diff-del-fg: #ffa198; --diff-del-bd: #5d1a1a;
    --diff-add-bg: #0d2818; --diff-add-fg: #7ee787; --diff-add-bd: #1a4d2e;
    --btn-send-bg: #238636; --btn-send-bg-hover: #2ea043;
    --btn-stop-bg: #9e6a03; --btn-stop-bg-hover: #bf8700;
    --btn-disabled-bg: #21262d; --btn-disabled-fg: #484f58;
    --btn-kill-bg: #da3633; --btn-kill-bg-hover: #f85149;
    --mic-rec-bg: #1a0a0a;
  }
  [data-theme="light"] {
    --bg: #ffffff; --fg: #24292f; --fg-strong: #1f2328; --fg-muted: #57606a; --fg-dim: #6e7781; --fg-faint: #8c959f;
    --panel: #f6f8fa; --panel-2: #eaeef2; --border: #d0d7de; --border-dim: #d8dee4;
    --link: #0969da; --link-2: #0969da;
    --accent-yellow: #9a6700; --accent-green: #1a7f37; --accent-red: #cf222e;
    --accent-purple-text: #8250df; --accent-purple-bg: #6639ba; --accent-user-text: #6639ba;
    --accent-orange: #bc4c00; --accent-orange-2: #bc4c00; --accent-green-2: #1a7f37;
    --ev-msg-bg: #fff8c5; --ev-init-bg: #dafbe1; --ev-think-bg: #f6f8fa; --ev-text-bg: #ddf4ff;
    --ev-tool-bg: #ddf4ff; --ev-tool-result-bg: #f6f8fa; --ev-result-bg: #dafbe1; --ev-user-bg: #fbefff;
    --ev-msg-bd: #bf8700; --ev-init-bd: #1a7f37; --ev-think-bd: #afb8c1; --ev-text-bd: #0969da;
    --ev-tool-bd: #0969da; --ev-tool-result-bd: #afb8c1; --ev-result-bd: #1a7f37; --ev-user-bd: #8250df;
    --code-bg: #eff1f3; --tool-cmd-bg: #f6f8fa; --tool-code-bg: #f6f8fa; --tool-pattern-bg: #ddf4ff;
    --diff-del-bg: #ffebe9; --diff-del-fg: #82071e; --diff-del-bd: #ff818266;
    --diff-add-bg: #dafbe1; --diff-add-fg: #116329; --diff-add-bd: #4ac26b66;
    --btn-send-bg: #1f883d; --btn-send-bg-hover: #1a7f37;
    --btn-stop-bg: #bf8700; --btn-stop-bg-hover: #9a6700;
    --btn-disabled-bg: #eaeef2; --btn-disabled-fg: #8c959f;
    --btn-kill-bg: #cf222e; --btn-kill-bg-hover: #a40e26;
    --mic-rec-bg: #fff0ee;
  }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 14px;
         padding-bottom: 80px; display: flex; align-items: flex-start; }
  #log { flex: 1; padding: 8px; min-width: 0; max-width: 1200px; }
  #status-panel { width: 280px; flex-shrink: 0; border-left: 1px solid var(--border-dim);
                  padding: 10px 12px; position: sticky; top: 0; max-height: 100vh; overflow-y: auto;
                  background: var(--panel); }
  #status-panel h3 { font-size: 12px; color: var(--fg-muted); letter-spacing: 0.5px; text-transform: uppercase;
                     margin-bottom: 8px; font-weight: 600; }
  .panel-head { display: flex; align-items: center; gap: 8px; padding: 4px 4px 8px;
                border-bottom: 1px solid var(--border); margin-bottom: 4px; }
  .panel-head h3 { margin: 0; flex: 1; }
  .panel-head label { display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 11px; color: var(--fg-muted); }
  .panel-head input[type=checkbox], .agent-row input[type=checkbox] { cursor: pointer; accent-color: var(--link); }
  .ev.hidden-by-filter { display: none !important; }
  .agent-row { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid var(--border-dim);
               font-size: 13px; cursor: pointer; }
  .agent-row.k-offline { cursor: default; }
  .agent-row .ar-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; background: var(--fg-faint); }
  .agent-row.k-idle      .ar-dot { background: var(--fg-dim); }
  .agent-row.k-thinking  .ar-dot { background: var(--accent-yellow); animation: ar-pulse 1.2s infinite; }
  .agent-row.k-tool      .ar-dot { background: var(--link); animation: ar-pulse 1.2s infinite; }
  .agent-row.k-writing   .ar-dot { background: var(--accent-green); animation: ar-pulse 1.2s infinite; }
  .agent-row.k-compacting .ar-dot { background: var(--accent-orange); animation: ar-pulse 1.2s infinite; }
  .agent-row.k-offline   { opacity: 0.5; }
  .agent-row.k-offline   .ar-dot { background: var(--fg-faint); }
  @keyframes ar-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  .ar-name { font-weight: 600; flex-shrink: 0; }
  .ar-state { color: var(--fg-muted); font-size: 12px; flex: 1; min-width: 0;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ar-since { color: var(--fg-faint); font-size: 11px; font-family: monospace; flex-shrink: 0; }
  @media (max-width: 800px) {
    body { flex-direction: column; }
    #status-panel { width: 100%; max-height: none; position: static; border-left: none;
                    border-bottom: 1px solid var(--border-dim); }
  }
  .ev { padding: 6px 10px; margin: 2px 0; border-radius: 6px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .ev-msg { background: var(--ev-msg-bg); border-left: 3px solid var(--ev-msg-bd); }
  .ev-init { background: var(--ev-init-bg); border-left: 3px solid var(--ev-init-bd); }
  .ev-think { background: var(--ev-think-bg); border-left: 3px solid var(--ev-think-bd); }
  .ev-text { background: var(--ev-text-bg); border-left: 3px solid var(--ev-text-bd); }
  .ev-tool { background: var(--ev-tool-bg); border-left: 3px solid var(--ev-tool-bd); }
  .ev-tool-result { background: var(--ev-tool-result-bg); border-left: 3px solid var(--ev-tool-result-bd); }
  .ev-result { background: var(--ev-result-bg); border-left: 3px solid var(--ev-result-bd); font-weight: 600; }
  .ev-user { background: var(--ev-user-bg); border-left: 3px solid var(--ev-user-bd); }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 700;
           color: #fff; letter-spacing: 0.5px; white-space: nowrap; flex-shrink: 0; cursor: pointer; }
  .badge-user { background: var(--accent-purple-bg); }
  .prompt-arrow { color: var(--fg-dim); }
  .user-text { color: var(--accent-user-text); font-size: 13px; white-space: pre-wrap; word-break: break-word;
               margin-top: 2px; background: none; }
  .task { color: var(--fg-muted); font-size: 12px; flex-shrink: 0; }
  .ts { color: var(--fg-faint); font-size: 11px; font-family: monospace; flex-shrink: 0; }
  .lbl { color: var(--accent-yellow); font-weight: 600; }
  .cost { color: var(--accent-orange); font-weight: 700; font-family: monospace; }
  .text-body { color: var(--fg); word-break: break-word; }
  .text-body p { margin: 0.3em 0; }
  .text-body ol, .text-body ul { margin: 0.3em 0 0.3em 1.5em; }
  .text-body code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .text-body pre { background: var(--code-bg); padding: 8px; border-radius: 6px; overflow-x: auto; margin: 0.3em 0; }
  .text-body pre code { background: none; padding: 0; }
  .text-body table { border-collapse: collapse; margin: 0.3em 0; }
  .text-body th, .text-body td { border: 1px solid var(--border); padding: 4px 8px; }
  .text-body th { background: var(--panel); }
  .text-body strong { color: var(--fg-strong); }
  .tool-name { color: var(--accent-purple-text); font-weight: 600; font-family: monospace; white-space: nowrap; }
  .tool-args { color: var(--fg-muted); font-family: monospace; font-size: 12px; word-break: break-all; }
  .tool-desc { color: var(--fg-muted); font-style: italic; }
  .tool-path { color: var(--link-2); font-family: monospace; }
  .tool-meta { color: var(--fg-dim); font-size: 11px; }
  .tool-cmd { color: var(--fg-strong); background: var(--tool-cmd-bg); padding: 2px 8px; border-radius: 4px;
              font-size: 12px; word-break: break-all; border: 1px solid var(--border-dim); }
  .tool-code { color: var(--fg-strong); background: var(--tool-code-bg); padding: 6px 10px; border-radius: 4px; margin-top: 4px;
               font-size: 12px; white-space: pre-wrap; word-break: break-all; border: 1px solid var(--border-dim); }
  .tool-code.text-body { white-space: normal; word-break: break-word; font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; }
  .tool-pattern { color: var(--accent-orange-2); background: var(--tool-pattern-bg); padding: 1px 6px; border-radius: 3px; }
  .tool-param-key { color: var(--accent-green-2); }
  .tool-param-val { color: var(--fg); }
  .diff-block { margin-top: 4px; font-family: monospace; font-size: 12px; width: 100%; }
  .diff-del { background: var(--diff-del-bg); color: var(--diff-del-fg); padding: 4px 8px; border-radius: 4px 4px 0 0; margin: 0;
              white-space: pre-wrap; word-break: break-all; border: 1px solid var(--diff-del-bd); }
  .diff-add { background: var(--diff-add-bg); color: var(--diff-add-fg); padding: 4px 8px; border-radius: 0 0 4px 4px; margin: 0;
              white-space: pre-wrap; word-break: break-all; border: 1px solid var(--diff-add-bd); border-top: none; }
  details { display: inline; }
  summary { cursor: pointer; color: var(--fg-muted); font-size: 12px; font-family: monospace; }
  summary:hover { color: var(--fg); }
  .think-text { color: var(--fg-dim); font-style: italic; font-size: 12px; white-space: pre-wrap; word-break: break-word;
                margin-top: 2px; background: none; }
  #status { position: fixed; top: 0; right: 0; padding: 4px 12px; background: var(--panel); border-bottom-left-radius: 8px;
            font-size: 11px; color: var(--accent-green); border: 1px solid var(--border-dim); z-index: 10; }
  #status.off { color: var(--accent-red); }
  #input-bar { position: fixed; bottom: 0; left: 0; right: 0; background: var(--panel); border-top: 1px solid var(--border-dim);
               padding: 8px 12px; display: flex; gap: 8px; align-items: center; z-index: 10; }
  #agent-select { background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px;
                  padding: 6px 10px; font-size: 13px; }
  #prompt-input { flex: 1; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px;
                  padding: 8px 12px; font-size: 14px; font-family: inherit; resize: none; min-height: 38px; max-height: 300px; overflow-y: auto; }
  #prompt-input:focus { outline: none; border-color: var(--link); }
  #stop-send-btn { background: var(--btn-stop-bg); color: #fff; border: none; border-radius: 6px; padding: 8px 16px;
                   font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  #stop-send-btn:hover { background: var(--btn-stop-bg-hover); }
  #stop-send-btn:disabled { background: var(--btn-disabled-bg); color: var(--btn-disabled-fg); cursor: not-allowed; }
  #kill-btn { background: var(--btn-kill-bg); color: #fff; border: none; border-radius: 6px; padding: 8px 16px;
              font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  #kill-btn:hover { background: var(--btn-kill-bg-hover); }
  #mic-btn { background: none; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px;
             font-size: 18px; cursor: pointer; color: var(--fg-muted); }
  #mic-btn:hover { border-color: var(--link); color: var(--link); }
  #mic-btn.recording { color: var(--accent-red); border-color: var(--accent-red); animation: pulse 1s infinite; background: var(--mic-rec-bg); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  #mic-status { color: var(--accent-red); font-size: 11px; font-weight: 600; letter-spacing: 0.5px; }
  #theme-btn { background: none; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px;
               font-size: 16px; cursor: pointer; color: var(--fg-muted); }
  #theme-btn:hover { border-color: var(--link); color: var(--link); }
</style>
</head><body>
<div id="status">connected</div>
<div id="log"></div>
<aside id="status-panel">
  <div class="panel-head">
    <h3>Агенты</h3>
    <label><input type="checkbox" id="filter-all" checked> Все</label>
  </div>
  <div id="agents-status"></div>
</aside>
<div id="input-bar">
  <select id="agent-select">{{AGENT_OPTIONS}}</select>
  <textarea id="prompt-input" placeholder="Сообщение агенту..." rows="1" autofocus></textarea>
  <button id="mic-btn" title="Голосовой ввод">🎤</button><span id="mic-status"></span>
  <button id="stop-send-btn" title="Прервать текущий turn и отправить новый prompt (Enter)">Stop&amp;Send</button>
  <button id="kill-btn" title="Kill agent (Esc)">Kill</button>
  <button id="theme-btn" title="Переключить тему"></button>
</div>
<script>
const log = document.getElementById('log');
const status = document.getElementById('status');
const input = document.getElementById('prompt-input');
const agentSel = document.getElementById('agent-select');
const stopSendBtn = document.getElementById('stop-send-btn');

let autoScroll = true;
window.addEventListener('scroll', () => {
  autoScroll = (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100;
});

const urlParams = new URLSearchParams(window.location.search);
const authToken = urlParams.get('token') || '';
const authHeader = authToken ? {'Authorization': 'Bearer ' + authToken} : {};
const tokenQS = authToken ? '?token=' + encodeURIComponent(authToken) : '';

// Панель статусов агентов: agent → {kind, detail, ts}
const agentsStatus = {};
const agentsContainer = document.getElementById('agents-status');
const KIND_LABEL = {
  idle: 'свободен', thinking: 'думает', tool: 'tool', writing: 'пишет ответ',
  compacting: 'сжатие контекста', offline: 'не запущен',
};
function fmtSince(ts) {
  const sec = Math.max(0, Math.floor(Date.now()/1000 - ts));
  if (sec < 60) return sec + 'с';
  if (sec < 3600) return Math.floor(sec/60) + 'м';
  return Math.floor(sec/3600) + 'ч';
}
function renderAgent(name) {
  const s = agentsStatus[name];
  if (!s) return;
  let row = document.getElementById('ag-' + name);
  if (!row) {
    row = document.createElement('div');
    row.id = 'ag-' + name;
    row.dataset.agent = name;
    row.className = 'agent-row';
    row.innerHTML = '<input type="checkbox" class="ar-cb" checked>'
                  + '<span class="ar-dot"></span><span class="ar-name"></span>'
                  + '<span class="ar-state"></span><span class="ar-since"></span>';
    const rows = Array.from(agentsContainer.children);
    const after = rows.find(r => r.id > row.id);
    if (after) agentsContainer.insertBefore(row, after); else agentsContainer.appendChild(row);
    row.querySelector('.ar-cb').addEventListener('change', onAgentCbChange);
    // Клик по строке (вне чекбокса) тоже переключает чекбокс
    row.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'INPUT') return;
      const cb = row.querySelector('.ar-cb');
      cb.checked = !cb.checked;
      onAgentCbChange();
    });
  }
  // Сохраняем класс с состоянием чекбокса (k-* отвечает за вид строки)
  const wasChecked = row.querySelector('.ar-cb').checked;
  row.className = 'agent-row k-' + s.kind;
  row.querySelector('.ar-name').textContent = name;
  const label = KIND_LABEL[s.kind] || s.kind;
  const detail = s.detail ? ': ' + s.detail : '';
  row.querySelector('.ar-state').textContent = label + detail;
  row.querySelector('.ar-since').textContent = fmtSince(s.ts);
  row.querySelector('.ar-cb').checked = wasChecked;
}

const filterAllCb = document.getElementById('filter-all');
function getEnabledAgents() {
  const set = new Set();
  agentsContainer.querySelectorAll('.agent-row .ar-cb').forEach(cb => {
    if (cb.checked) set.add(cb.closest('.agent-row').dataset.agent);
  });
  return set;
}
function applyFilter() {
  const enabled = getEnabledAgents();
  const total = agentsContainer.querySelectorAll('.ar-cb').length;
  filterAllCb.checked = (total > 0 && enabled.size === total);
  // Обходим все .ev в логе
  document.querySelectorAll('#log .ev').forEach(ev => {
    const ag = ev.dataset.agent;
    // Без data-agent (системные/user prompts) — всегда видимы
    if (!ag) { ev.classList.remove('hidden-by-filter'); return; }
    if (enabled.has(ag)) ev.classList.remove('hidden-by-filter');
    else ev.classList.add('hidden-by-filter');
  });
}
function onAgentCbChange() { applyFilter(); }
filterAllCb.addEventListener('change', () => {
  const v = filterAllCb.checked;
  agentsContainer.querySelectorAll('.ar-cb').forEach(cb => { cb.checked = v; });
  applyFilter();
});
setInterval(() => {
  for (const name of Object.keys(agentsStatus)) {
    const row = document.getElementById('ag-' + name);
    if (row) row.querySelector('.ar-since').textContent = fmtSince(agentsStatus[name].ts);
  }
}, 1000);

const es = new EventSource('/logs/stream' + tokenQS);
es.addEventListener('status', (e) => {
  try {
    const s = JSON.parse(e.data);
    if (!s.agent) return;
    agentsStatus[s.agent] = s;
    renderAgent(s.agent);
  } catch (err) { /* ignore */ }
});
es.onmessage = (e) => {
  const div = document.createElement('div');
  div.innerHTML = e.data;
  const enabled = getEnabledAgents();
  const totalAgents = agentsContainer.querySelectorAll('.ar-cb').length;
  const filterActive = totalAgents > 0 && enabled.size < totalAgents;
  div.querySelectorAll('.ev').forEach(ev => {
    const tsAttr = ev.getAttribute('data-ts');
    const tsMs = tsAttr ? parseFloat(tsAttr) * 1000 : Date.now();
    const tsStr = new Date(tsMs).toLocaleTimeString('en-GB', {hour12: false});
    ev.insertAdjacentHTML('afterbegin', '<span class="ts">' + tsStr + '</span>');
    // Прокидываем data-agent на сам ev из первого badge[data-agent] внутри
    const badgeAgent = ev.querySelector('.badge[data-agent]');
    if (badgeAgent) ev.dataset.agent = badgeAgent.dataset.agent;
    // Применяем текущий фильтр сразу при появлении
    if (filterActive && ev.dataset.agent && !enabled.has(ev.dataset.agent)) {
      ev.classList.add('hidden-by-filter');
    }
  });
  div.querySelectorAll('.text-body').forEach(el => {
    el.innerHTML = marked.parse(el.textContent);
  });
  while (div.firstChild) log.appendChild(div.firstChild);
  while (log.childElementCount > 2000) log.removeChild(log.firstChild);
  if (autoScroll) window.scrollTo(0, document.body.scrollHeight);
};
es.onopen = () => { status.textContent = 'connected'; status.className = ''; };
es.onerror = () => { status.textContent = 'reconnecting...'; status.className = 'off'; };

// Auto-resize textarea
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 300) + 'px';
});

async function sendPrompt() {
  const text = input.value.trim();
  if (!text) return;
  const agent = agentSel.value;
  stopSendBtn.disabled = true;
  try {
    const res = await fetch('/prompt', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...authHeader},
      body: JSON.stringify({agent, text, interrupt: true}),
    });
    if (res.ok) {
      input.value = '';
      input.style.height = 'auto';
    }
  } finally {
    stopSendBtn.disabled = false;
    input.focus();
  }
}

stopSendBtn.addEventListener('click', sendPrompt);

const killBtn = document.getElementById('kill-btn');
async function killAgent() {
  const agent = agentSel.value;
  const res = await fetch('/agent/kill', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...authHeader},
    body: JSON.stringify({agent}),
  });
  if (res.ok) {
    const data = await res.json();
    if (data.status === 'killed') {
      const div = document.createElement('div');
      div.className = 'ev system';
      const ts = new Date().toLocaleTimeString('en-GB', {hour12: false});
      div.innerHTML = '<span class="ts">' + ts + '</span> агент <b>' + agent + '</b> убит';
      log.appendChild(div);
      if (autoScroll) window.scrollTo(0, document.body.scrollHeight);
    }
  }
}
killBtn.addEventListener('click', () => { killAgent().then(() => input.focus()); });

const themeBtn = document.getElementById('theme-btn');
function updateThemeIcon() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  themeBtn.textContent = light ? '☀' : '☾';
}
updateThemeIcon();
themeBtn.addEventListener('click', () => {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  if (light) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('theme', 'light');
  }
  updateThemeIcon();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { killAgent().then(() => input.focus()); }
});
document.addEventListener('click', (e) => {
  const badge = e.target.closest('.badge[data-agent]');
  if (badge) {
    const agent = badge.dataset.agent;
    if ([...agentSel.options].some(o => o.value === agent)) {
      agentSel.value = agent;
    }
  }
  if (!e.target.closest('#input-bar')) input.focus();
});

// Voice input
const micBtn = document.getElementById('mic-btn');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.lang = 'ru-RU';
  recognition.interimResults = true;
  recognition.continuous = true;
  let finalText = '';
  let isRecording = false;

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      isRecording = false;
      recognition.stop();
    } else {
      finalText = input.value;
      lastFinalIdx = 0;
      recognition.start();
    }
  });

  const micStatus = document.getElementById('mic-status');
  recognition.onstart = () => {
    isRecording = true;
    micBtn.classList.add('recording');
    micStatus.textContent = 'REC';
  };
  recognition.onend = () => {
    if (isRecording) {
      recognition.start();
      return;
    }
    micBtn.classList.remove('recording');
    micStatus.textContent = '';
  };
  let lastFinalIdx = 0;
  recognition.onresult = (e) => {
    let final = finalText;
    let interim = '';
    for (let i = lastFinalIdx; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        final += (final ? ' ' : '') + e.results[i][0].transcript;
        lastFinalIdx = i + 1;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    finalText = final;
    input.value = final + (interim ? ' ' + interim : '');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 300) + 'px';
  };
  recognition.onerror = (e) => {
    if (e.error !== 'no-speech') console.error('Speech error:', e.error);
  };
} else {
  micBtn.style.display = 'none';
}
</script>
</body></html>"""


class WebhookHandler(BaseHTTPRequestHandler):
    def _get_roles(self) -> list[str] | None:
        """Возвращает список ролей из токена. None если токен невалидный."""
        if not WEBHOOK_AUTH_TOKEN:
            return _ALL_ROLES
        auth = self.headers.get("Authorization", "")
        token = auth.replace("Bearer ", "", 1) if auth.startswith("Bearer ") else ""
        if not token:
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            token = qs.get("token", [""])[0]
        if not token:
            return None
        # Пользовательский (главный) токен — все роли
        if token == WEBHOOK_AUTH_TOKEN:
            return _ALL_ROLES
        return _parse_token(token)

    def _check_auth(self) -> bool:
        """Проверяет токен. Сохраняет roles в self._roles."""
        roles = self._get_roles()
        if roles is not None:
            self._roles = roles
            return True
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "unauthorized"}).encode())
        return False

    def _check_role(self, endpoint: str, scope: str = None) -> bool:
        """Проверяет что токен содержит роль необходимую для endpoint."""
        roles = getattr(self, "_roles", None) or []
        spec = ENDPOINT_ROLE.get(endpoint)
        if spec is None:
            return True  # endpoint без ролевых ограничений
        if isinstance(spec, dict):
            required = spec.get(scope or "", None)
        else:
            required = spec
        if required and required in roles:
            return True
        self.send_response(403)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({
            "error": f"forbidden: missing role {required} for {endpoint}" + (f" scope='{scope}'" if scope else ""),
            "token_roles": roles,
        }).encode())
        return False

    def do_POST(self):
        path = self.path.split("?")[0]

        # /feedback/notify использует свой секрет
        if path != "/feedback/notify" and not self._check_auth():
            return

        if path == "/prompt":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                return
            agent = payload.get("agent", "coordinator").lower()
            text = payload.get("text", "").strip()
            if not text:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error":"empty text"}')
                return
            valid = get_valid_agents()
            if agent not in valid:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"unknown agent: {agent}"}).encode())
                return
            _log_user_prompt(agent, text, source="web")
            send_to_agent(agent, f"[Web] {text}\n\nОтветь текстовым сообщением. НЕ отправляй ответ в Telegram — ответ виден в веб-интерфейсе.")
            log(f"Web prompt -> {agent}: {text[:80]}")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "sent", "agent": agent}).encode())
            return

        if path == "/agent/message":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                return
            handle_agent_message(self, payload)
            return

        if path == "/agent/stop":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                return
            agent = payload.get("agent", "").lower()
            valid = get_valid_agents()
            if agent not in valid:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"unknown agent '{agent}'"}).encode())
                return
            with agent_daemons_lock:
                daemon = agent_daemons.get(agent)
            if not daemon or not daemon.is_alive():
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"status": "not_running", "agent": agent}).encode())
                return
            ok = daemon.interrupt()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "interrupted" if ok else "failed", "agent": agent}).encode())
            return

        if path == "/agent/logs":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                payload = {}
            agent = payload.get("agent", "").lower()
            limit = int(payload.get("limit", 30))
            valid = get_valid_agents()
            if agent not in valid:
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"unknown agent '{agent}'"}).encode())
                return
            # Собираем все session_id, когда-либо принадлежавшие этому агенту.
            # Маркер — записи {"type":"agent_init","agent":<name>,"session_id":<sid>}
            # пишет AgentDaemon._read_stdout при захвате нового session_id.
            # Плюс текущий sid живого daemon'а (если ещё не успел залогироваться).
            agent_sids: set[str] = set()
            with agent_daemons_lock:
                daemon = agent_daemons.get(agent)
            if daemon and daemon.session_id:
                agent_sids.add(daemon.session_id)
            events = []
            agent_marker = f'"agent": "{agent}"'
            try:
                with open(os.path.join(LOG_DIR, "agents.log")) as f:
                    for line in f:
                        # Дешёвый префильтр по подстроке для собирания sid'ов
                        # агента из agent_init-маркеров.
                        if agent_marker in line and '"agent_init"' in line:
                            try:
                                data = json.loads(line)
                                if data.get("type") == "agent_init" and data.get("agent") == agent:
                                    sid = data.get("session_id")
                                    if sid:
                                        agent_sids.add(sid)
                            except (json.JSONDecodeError, ValueError):
                                pass
                            continue
                        # Префильтр по любому из собранных sid'ов в строке.
                        if not any(s in line for s in agent_sids):
                            continue
                        try:
                            data = json.loads(line)
                        except (json.JSONDecodeError, ValueError):
                            continue
                        if data.get("session_id") not in agent_sids:
                            continue
                        t = data.get("type")
                        ts = data.get("ts")
                        if t == "assistant":
                            for c in data.get("message", {}).get("content", []):
                                ct = c.get("type")
                                if ct == "text":
                                    events.append({"ts": ts, "kind": "text", "text": c.get("text", "")[:1000]})
                                elif ct == "tool_use":
                                    events.append({"ts": ts, "kind": "tool_use", "name": c.get("name"), "input": c.get("input", {})})
                        elif t == "user":
                            for c in data.get("message", {}).get("content", []):
                                if c.get("type") == "tool_result":
                                    content = c.get("content", "")
                                    if isinstance(content, list):
                                        content = " ".join(x.get("text", "") for x in content if isinstance(x, dict))
                                    events.append({"ts": ts, "kind": "tool_result", "error": bool(c.get("is_error")), "content": str(content)[:500]})
                        elif t == "result":
                            events.append({"ts": ts, "kind": "result", "cost": data.get("total_cost_usd", 0)})
            except Exception as e:
                log(f"/agent/logs error: {e}")
            sid = (daemon.session_id if daemon else None) or (next(iter(agent_sids), None))
            events = events[-limit:]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"agent": agent, "session_id": sid, "events": events}).encode())
            return

        if path == "/agent/kill":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                return
            agent = payload.get("agent", "").lower()
            valid = get_valid_agents()
            if agent not in valid:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"unknown agent '{agent}'"}).encode())
                return
            with agent_daemons_lock:
                daemon = agent_daemons.get(agent)
            if not daemon or not daemon.is_alive():
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"status": "not_running", "agent": agent}).encode())
                return
            daemon.stop()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "killed", "agent": agent}).encode())
            return

        if path == "/telegram/send":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                return
            handle_telegram_send(self, payload)
            return

        if path == "/feedback/notify":
            handle_feedback_notify(self)
            return

        if path == "/ai-chat":
            handle_ai_chat(self)
            return

        if path == "/commit":
            if not self._check_role("/commit"):
                return
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                payload = {}
            message = payload.get("message", "")
            files = payload.get("files", [])
            agent = str(payload.get("agent", "") or "").lower().strip()
            if not message:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "missing 'message'"}).encode())
                return
            if not files:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "missing 'files' — explicit file list required"}).encode())
                return
            log(f"Commit (agent={agent or '?'}): {message[:72]}, files={files}")
            author_overrides: list[str] = []
            if agent and agent in AGENT_ROLES:
                pretty = {
                    "backend": "Backend Agent",
                    "frontend": "Frontend Agent",
                    "layout": "Layout Agent",
                    "devops": "DevOps Agent",
                    "architect": "Architect Agent",
                    "qa": "QA Agent",
                    "coordinator": "Coordinator Agent",
                    "content": "Content Agent",
                    "marketing": "Marketing Agent",
                }.get(agent, agent.title() + " Agent")
                email = f"{agent}@kingside.dev"
                author_overrides = [
                    "-c", f"user.name={pretty}",
                    "-c", f"user.email={email}",
                    "-c", "commit.gpgsign=false",
                ]
            try:
                subprocess.run(
                    ["git", "add"] + files,
                    cwd=PROJECT_DIR, capture_output=True, text=True, timeout=30,
                )
                result = subprocess.run(
                    ["git"] + author_overrides + ["commit", "-m", message],
                    cwd=PROJECT_DIR, capture_output=True, text=True, timeout=60,
                )
                ok = result.returncode == 0
                log(f"Commit завершён: rc={result.returncode}")
                self.send_response(200 if ok else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "success" if ok else "failed",
                    "stdout": result.stdout[-1000:],
                    "stderr": result.stderr[-1000:],
                }).encode())
            except Exception as e:
                log(f"Commit ошибка: {e}")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "detail": str(e)}).encode())
            return

        if path == "/npm-install":
            if not self._check_role("/npm-install"):
                return
            log("npm install запущен")
            try:
                result = subprocess.run(
                    ["npm", "install"],
                    cwd=PROJECT_DIR, capture_output=True, text=True, timeout=120,
                )
                ok = result.returncode == 0
                log(f"npm install завершён: rc={result.returncode}")
                self.send_response(200 if ok else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "success" if ok else "failed",
                    "stdout": result.stdout[-1000:],
                    "stderr": result.stderr[-1000:],
                }).encode())
            except Exception as e:
                log(f"npm install ошибка: {e}")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "detail": str(e)}).encode())
            return

        if path == "/npm-run":
            if not self._check_role("/npm-run"):
                return
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                payload = {}
            script = payload.get("script", "")
            if script not in NPM_RUN_ALLOWED:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"script must be one of {sorted(NPM_RUN_ALLOWED)}"}).encode())
                return
            workspace = payload.get("workspace", "")
            cmd = ["npm", "run", script]
            if workspace:
                cmd.extend(["--workspace", workspace])
            log(f"npm-run: {' '.join(cmd)}")
            try:
                result = subprocess.run(
                    cmd, cwd=PROJECT_DIR, capture_output=True, text=True, timeout=600,
                )
                ok = result.returncode == 0
                log(f"npm-run завершён: rc={result.returncode}")
                self.send_response(200 if ok else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "success" if ok else "failed",
                    "returncode": result.returncode,
                    "stdout": result.stdout[-3000:],
                    "stderr": result.stderr[-3000:],
                }).encode())
            except subprocess.TimeoutExpired:
                self.send_response(504)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "timeout"}).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "detail": str(e)}).encode())
            return

        if path == "/docker-compose":
            if not self._check_role("/docker-compose"):
                return
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                payload = {}
            command = payload.get("command", "")
            if command not in DOCKER_COMPOSE_ALLOWED:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"command must be one of {sorted(DOCKER_COMPOSE_ALLOWED)}"}).encode())
                return
            extra_args = payload.get("args", [])
            if not isinstance(extra_args, list) or not all(isinstance(a, str) for a in extra_args):
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "args must be list of strings"}).encode())
                return
            cmd = ["docker", "compose", command] + extra_args
            log(f"docker-compose: {' '.join(cmd)}")
            try:
                result = subprocess.run(
                    cmd, cwd=PROJECT_DIR, capture_output=True, text=True, timeout=600,
                )
                ok = result.returncode == 0
                log(f"docker-compose завершён: rc={result.returncode}")
                self.send_response(200 if ok else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "success" if ok else "failed",
                    "returncode": result.returncode,
                    "stdout": result.stdout[-3000:],
                    "stderr": result.stderr[-3000:],
                }).encode())
            except subprocess.TimeoutExpired:
                self.send_response(504)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "timeout"}).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "detail": str(e)}).encode())
            return

        if path == "/up":
            if not self._check_role("/up"):
                return
            log("just up запущен")
            try:
                result = subprocess.run(
                    ["just", "up"],
                    cwd=PROJECT_DIR, capture_output=True, text=True, timeout=300,
                )
                ok = result.returncode == 0
                log(f"just up завершён: rc={result.returncode}")
                self.send_response(200 if ok else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "success" if ok else "failed",
                    "stdout": result.stdout[-2000:],
                    "stderr": result.stderr[-2000:],
                }).encode())
            except subprocess.TimeoutExpired:
                log("just up таймаут")
                self.send_response(504)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "timeout"}).encode())
            except Exception as e:
                log(f"just up ошибка: {e}")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "detail": str(e)}).encode())
            return

        if path == "/vite-start":
            if not self._check_role("/vite-start"):
                return
            log("Vite start запрошен")
            import socket

            def _port_up(port: int) -> bool:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(0.5)
                try:
                    s.connect(("127.0.0.1", port))
                    s.close()
                    return True
                except (ConnectionRefusedError, socket.timeout, OSError):
                    return False

            def _tail(path, n=80):
                try:
                    with open(path) as f:
                        return "".join(f.readlines()[-n:])
                except FileNotFoundError:
                    return ""

            stdout_path = os.path.join(LOG_DIR, "vite-stdout.log")
            stderr_path = os.path.join(LOG_DIR, "vite-stderr.log")

            # Убиваем процесс на 5173 всегда — чтобы перезапустить
            subprocess.run(["fuser", "-k", "5173/tcp"], capture_output=True, timeout=5)
            time.sleep(1)

            try:
                env = os.environ.copy()
                proc = subprocess.Popen(
                    ["npm", "run", "dev"],
                    cwd=os.path.join(PROJECT_DIR, "apps/web"), env=env,
                    stdout=open(stdout_path, "w"),
                    stderr=open(stderr_path, "w"),
                    start_new_session=True,
                )
                deadline = time.time() + 30
                started = False
                while time.time() < deadline:
                    if _port_up(5173):
                        started = True
                        break
                    if proc.poll() is not None:
                        break
                    time.sleep(1)

                body = {
                    "status": "started" if started else "failed",
                    "pid": proc.pid,
                    "stdout": _tail(stdout_path),
                    "stderr": _tail(stderr_path),
                }
                self.send_response(200 if started else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())
                log(f"Vite start завершён: started={started} pid={proc.pid}")
            except Exception as e:
                log(f"Vite start ошибка: {e}")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "error", "detail": str(e),
                    "stdout": _tail(stdout_path), "stderr": _tail(stderr_path),
                }).encode())
            return

        if path == "/api-start":
            if not self._check_role("/api-start"):
                return
            content_length = int(self.headers.get("Content-Length", 0))
            body_raw = self.rfile.read(content_length) if content_length else b""
            try:
                payload = json.loads(body_raw) if body_raw else {}
            except json.JSONDecodeError:
                payload = {}
            force = bool(payload.get("force"))
            log(f"API start запрошен (force={force})")
            import socket

            def _port_up(port: int) -> bool:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(0.5)
                try:
                    s.connect(("127.0.0.1", port))
                    s.close()
                    return True
                except (ConnectionRefusedError, socket.timeout, OSError):
                    return False

            def _tail(path, n=80):
                try:
                    with open(path) as f:
                        return "".join(f.readlines()[-n:])
                except FileNotFoundError:
                    return ""

            stdout_path = os.path.join(LOG_DIR, "api-stdout.log")
            stderr_path = os.path.join(LOG_DIR, "api-stderr.log")

            if not force and _port_up(3001):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "already_running"}).encode())
                return

            # Убиваем зависшие процессы на портах которые могут помешать старту.
            # При force=true это и есть «перезапуск» — убили живой процесс на 3001,
            # подняли заново с актуальным .env. Vite (5173) трогаем только если
            # он был сломан (подъём API сам vite не запускает — это делает
            # /vite-start, но на всякий случай освобождаем порт).
            for port in (3001, 5173):
                subprocess.run(["fuser", "-k", f"{port}/tcp"], capture_output=True, timeout=5)
            if force:
                time.sleep(1)

            try:
                env = os.environ.copy()
                # Открываем в режиме truncate — чтобы логи были только от последнего запуска
                proc = subprocess.Popen(
                    ["npm", "run", "dev"],
                    cwd=PROJECT_DIR, env=env,
                    stdout=open(stdout_path, "w"),
                    stderr=open(stderr_path, "w"),
                    start_new_session=True,
                )
                # Ждём пока порт поднимется (макс 60с)
                deadline = time.time() + 60
                started = False
                while time.time() < deadline:
                    if _port_up(3001):
                        started = True
                        break
                    if proc.poll() is not None:
                        break
                    time.sleep(1)

                body = {
                    "status": "started" if started else "failed",
                    "pid": proc.pid,
                    "stdout": _tail(stdout_path),
                    "stderr": _tail(stderr_path),
                }
                if not started:
                    body["hint"] = "API не поднялся за 60с. См. stdout/stderr."
                self.send_response(200 if started else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())
                log(f"API start завершён: started={started} pid={proc.pid}")
            except Exception as e:
                log(f"API start ошибка: {e}")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "error",
                    "detail": str(e),
                    "stdout": _tail(stdout_path),
                    "stderr": _tail(stderr_path),
                }).encode())
            return

        if path == "/deploy":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                payload = {}
            scope = payload.get("scope", "")
            if not self._check_role("/deploy", scope):
                return
            # KS: scope=all и workers запрещены. Deploy должен быть атомарным,
            # один scope за раз — это даёт прозрачность статуса (агент видит
            # успех/фейл по конкретному сервису), независимый rollback и
            # отсутствие side-эффекта когда один из 7 сервисов упал, а
            # остальные уже выкачены.
            if scope in ("all", "workers", ""):
                log(f"Deploy ОТКАЗАНО: scope='{scope}' (запрещено). Только per-scope: frontend/api/game-service/broadcast-service/archive-service/synthetic-bot/tactic-worker/prerender-service.")
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "rejected",
                    "error": f"scope='{scope}' запрещено. Deploy атомарный — один scope за вызов.",
                    "allowed": ["frontend", "api", "game-service", "broadcast-service", "archive-service", "synthetic-bot", "tactic-worker", "prerender-service"],
                    "hint": "Если нужно несколько сервисов — последовательные вызовы с явными scope. Координация нескольких scope — задача координатора, не одного MCP-вызова.",
                }, ensure_ascii=False).encode())
                return
            cmd = ["bash", os.path.join(PROJECT_DIR, "scripts/deploy-aws.sh"), scope]
            # Per-scope деплой укладывается в 5-10 мин; берём с запасом 15 мин.
            deploy_timeout = 900
            log(f"Deploy запущен: {' '.join(cmd)} (timeout {deploy_timeout}s)")
            try:
                env = os.environ.copy()
                result = subprocess.run(
                    cmd, cwd=PROJECT_DIR, env=env,
                    capture_output=True, text=True, timeout=deploy_timeout,
                )
                log(f"Deploy завершён: rc={result.returncode}")
                ok = result.returncode == 0
                self.send_response(200 if ok else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "success" if ok else "failed",
                    "returncode": result.returncode,
                    "stdout": result.stdout[-2000:],
                    "stderr": result.stderr[-2000:],
                }).encode())
            except subprocess.TimeoutExpired:
                log(f"Deploy таймаут ({deploy_timeout}s)")
                self.send_response(504)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "timeout"}).encode())
            except Exception as e:
                log(f"Deploy ошибка: {e}")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "detail": str(e)}).encode())
            return

        if path == "/git-log":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                payload = {}
            if not self._check_role("/git-log"):
                return
            since = str(payload.get("since", "") or "")
            try:
                limit = int(payload.get("limit", 50))
            except (TypeError, ValueError):
                limit = 50
            limit = max(1, min(limit, 500))
            path_filter = str(payload.get("path", "") or "")
            grep = str(payload.get("grep", "") or "")
            sha = str(payload.get("sha", "") or "")
            mode = str(payload.get("mode", "log") or "log")
            cmd = ["git", "-C", PROJECT_DIR]
            if mode == "show":
                if not sha or not all(c in "0123456789abcdefABCDEF" for c in sha):
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "invalid sha"}).encode())
                    return
                cmd += ["show", "--stat", "--patch", "--no-color", sha]
            else:
                cmd += ["log", "--no-color", f"-n{limit}",
                        "--pretty=format:%h%x09%ad%x09%an%x09%s", "--date=iso-strict"]
                if since:
                    cmd.append(f"--since={since}")
                if grep:
                    cmd += ["--grep", grep]
                if path_filter:
                    cmd += ["--", path_filter]
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                stdout = result.stdout
                if mode == "show":
                    stdout = stdout[:50000]
                self.send_response(200 if result.returncode == 0 else 500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "returncode": result.returncode,
                    "stdout": stdout,
                    "stderr": result.stderr[-2000:],
                }).encode())
            except subprocess.TimeoutExpired:
                self.send_response(504)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "timeout"}).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "detail": str(e)}).encode())
            return

        if path != "/webhook/tracker":
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        dump_path = os.path.join(LOG_DIR, "webhook-dump.json")
        with open(dump_path, "a") as df:
            df.write(f"--- {datetime.now()} CL={content_length} path={self.path} ---\n")
            df.write(body.decode("utf-8", errors="replace") + "\n")

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            log(f"Ошибка: невалидный JSON (CL={content_length})")
            self.send_response(400)
            self.end_headers()
            return

        event = payload.get("event", "")
        log(f"Получен webhook: {event}")

        issue = payload.get("issue", {})
        key = issue.get("key", payload.get("issue_key", ""))
        summary = issue.get("summary", "")
        issue_status = issue.get("status", "")

        # Маппинг статусов трекера в категории
        STATUS_CATEGORY_MAP = {"todo": "new", "in_progress": "indeterminate", "done": "done"}
        status_category = STATUS_CATEGORY_MAP.get(issue_status, "")

        if event == "comment_added":
            comment = payload.get("comment", {})
            comment_text = comment.get("body", "")

            # Telegram: только комментарии от coordinator
            if comment.get("author", "").lower() == "coordinator":
                tg = format_telegram_issue(event, payload)
                if tg:
                    send_telegram(tg[0], parse_mode=tg[1])

            if status_category == "done":
                log(f"Пропуск {key}: задача в статусе Done")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"skipped","reason":"done"}')
                return

            if not key or not comment_text:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"skipped"}')
                return

            valid_agents = get_valid_agents()
            comment_author = comment.get("author", "").lower()
            author_agent = comment_author if comment_author in valid_agents else None

            mentions = re.findall(r"@(\w+)", comment_text)
            agents = []
            for m in mentions:
                name = m.lower()
                if name not in valid_agents or name == author_agent:
                    continue
                if name == "coordinator":
                    agents.append(name)
                elif status_category == "new":
                    agents.append(name)

            if "coordinator" in valid_agents and author_agent != "coordinator" and "coordinator" not in agents:
                agents.append("coordinator")

            if not agents:
                log(f"Комментарий к {key}: нет агентов для обработки, пропуск")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"skipped"}')
                return

            details = _get_issue_details(key)
            description = details.get("description", "")
            comments_history = details.get("comments", [])
            linked = details.get("linked", [])

            desc_block = f"\nОписание задачи:\n{description}\n" if description else ""
            comments_block = ""
            if comments_history:
                comments_block = "\nИстория комментариев:\n" + "\n".join(comments_history) + "\n"
            linked_block = ""
            if linked:
                linked_block = "\nСвязанные задачи:\n" + "\n".join(linked) + "\n"

            context = f"{desc_block}{comments_block}{linked_block}"

            for agent in agents:
                role = agent.upper()
                if agent != "coordinator":
                    prompt = (
                        f"Задача {key}: {summary}\n"
                        f"Общайся и думай на русском языке.\n"
                        f"Рабочая директория: /project\n"
                        f"ЕСЛИ ОКРУЖЕНИЕ НЕ РАБОТАЕТ (dev-сервер, API, CORS, auth, модули) — НЕМЕДЛЕННО ПРЕКРАТИ РАБОТУ. "
                        f"Добавь комментарий 'Окружение не готово: <проблема>. @coordinator' и ЗАВЕРШИ. Не пытайся чинить.\n"
                        f"{context}\n"
                        f"Получен новый комментарий:\n{comment_text}\n\n"
                        f"1. Переведи задачу в статус 'In Progress' (transitionId: 21) — это можешь только ты как assignee.\n"
                        f"2. Прочитай комментарий и выполни то, что в нём написано\n"
                        f"3. Коммитни изменения через /commit endpoint\n"
                        f"4. Добавь комментарий с результатом и тегни @coordinator\n"
                        f"5. Закрытие задачи (transitionId: 41) делает только координатор. Ты НЕ переводишь в Done — получишь 403."
                    )
                else:
                    prompt = (
                        f"Задача {key}: {summary}\n"
                        f"Общайся и думай на русском языке.\n"
                        f"{context}\n"
                        f"Получен новый комментарий:\n{comment_text}\n\n"
                        f"1. Прочитай комментарий и выполни то, что в нём написано\n"
                        f"2. Добавь комментарий с результатом"
                    )
                log(f"Комментарий к {key} -> daemon {agent}")
                launch_agent(key, summary, agent, prompt)

            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "comment_handled", "agents": agents, "key": key}).encode())
            return

        if event == "issue_transitioned":
            transition_id = payload.get("transition_id")

            # in_review (transition_id 31) — пока не поддерживается в трекере
            if transition_id == 31 and key:
                log(f"Задача {key}: transition_id=31 (in_review), пока не обрабатывается")

            tg = format_telegram_issue(event, payload)
            if tg:
                send_telegram(tg[0], parse_mode=tg[1])

            log(f"Событие {event}: {key} -> {issue_status}")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "transition_handled", "key": key}).encode())
            return

        if event in ("issue_created", "issue_updated"):
            tg = format_telegram_issue(event, payload)
            if tg:
                send_telegram(tg[0], parse_mode=tg[1])
            log(f"Событие {event}: {key} — уведомление отправлено")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"notified"}')
            return

        log(f"Игнорируем событие: {event}")
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"status":"ignored"}')

    def do_GET(self):
        path = self.path.split("?")[0]

        # /health без аутентификации
        if path != "/health" and not self._check_auth():
            return

        if path == "/health":
            status = {}
            with agent_daemons_lock:
                for name, daemon in agent_daemons.items():
                    status[name] = {
                        "alive": daemon.is_alive(),
                        "pid": daemon.proc.pid if daemon.proc else None,
                        "session_id": daemon.session_id,
                        "total_cost_usd": round(daemon._total_cost, 4),
                        "message_count": daemon._message_count,
                        "rss_mb": daemon.get_rss_mb(),
                    }
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "daemons": status}).encode())
            return

        if path == "/logs":
            agents = sorted(get_valid_agents())
            if "coordinator" in agents:
                agents.remove("coordinator")
                agents.insert(0, "coordinator")
            options = "".join(f'<option value="{a}">{a}</option>' for a in agents)
            html = LOGS_HTML.replace("{{AGENT_OPTIONS}}", options)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html.encode())
            return

        if path == "/logs/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                _stream_logs_sse(self.wfile)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        pass


# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------

def shutdown_daemons():
    """Останавливает все daemon-процессы."""
    with agent_daemons_lock:
        for name, daemon in agent_daemons.items():
            daemon.stop()


if __name__ == "__main__":
    # Лог агентов не ротируется на старте — переписка с агентами сохраняется
    # между рестартами webhook-сервера. Ротация (если понадобится) — вручную.
    agents_log = os.path.join(LOG_DIR, "agents.log")
    open(agents_log, "a").close()

    # Telegram polling
    poll_thread = threading.Thread(target=telegram_poll_loop, daemon=True)
    poll_thread.start()

    # Фоновая очистка idle chat daemons
    chat_cleanup_thread = threading.Thread(target=_chat_daemon_cleanup_loop, daemon=True)
    chat_cleanup_thread.start()

    # Cron-пинг координатора каждые 7 мин (проверка зависших задач)
    coord_cron_thread = threading.Thread(target=coordinator_cron_loop, daemon=True)
    coord_cron_thread.start()

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

    server = ThreadingHTTPServer(("127.0.0.1", PORT), WebhookHandler)
    log(f"Webhook-сервер v2.0 запущен на порту {PORT} (daemon-режим агентов)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Остановка: завершаем daemon-агентов...")
        shutdown_daemons()
        log("Webhook-сервер остановлен")
        server.server_close()
