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

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(PROJECT_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9876

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

TRACKER_URL = os.environ.get("TRACKER_URL", "http://localhost:8090")

AGENTS_DIR = os.path.join(PROJECT_DIR, ".claude", "agents")


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
        # Событие: агент закончил обработку текущего сообщения
        self._idle = threading.Event()
        self._idle.set()
        # Очередь сообщений для последовательной отправки
        self._queue: list[str] = []
        self._queue_lock = threading.Lock()
        self._worker_thread: threading.Thread | None = None
        # Статистика сессии
        self._total_cost: float = 0.0
        self._message_count: int = 0

    def _build_cmd(self) -> list[str]:
        cmd = [
            "claude", "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--agent", self.name,
            "--dangerously-skip-permissions",
        ]
        if self.session_id:
            cmd.extend(["--resume", self.session_id])
            log(f"Daemon {self.name}: resume сессии {self.session_id}")
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
                cmd, cwd=PROJECT_DIR, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=lf,
                start_new_session=True, text=True, bufsize=1,
            )

        self._idle.set()
        self._total_cost = 0.0
        self._message_count = 0
        log(f"Daemon {self.name} запущен (PID: {self.proc.pid})")

        # Записываем agent_init в лог для follow.sh
        with open(log_file, "a") as lf:
            lf.write(json.dumps({"type": "agent_init", "agent": self.name, "session_id": self.session_id or ""}) + "\n")

        # Поток чтения stdout
        self._reader_thread = threading.Thread(
            target=self._read_stdout, daemon=True,
        )
        self._reader_thread.start()

        # Worker-поток для последовательной отправки сообщений
        if not self._worker_thread or not self._worker_thread.is_alive():
            self._worker_thread = threading.Thread(
                target=self._worker_loop, daemon=True,
            )
            self._worker_thread.start()

    def _read_stdout(self):
        """Читает stdout daemon-процесса, логирует и ловит session_id / result."""
        log_file = os.path.join(LOG_DIR, "agents.log")
        proc = self.proc
        try:
            for line in iter(proc.stdout.readline, ""):
                with open(log_file, "a") as lf:
                    lf.write(line)
                line_s = line.strip()
                if not line_s:
                    continue
                try:
                    data = json.loads(line_s)
                except (json.JSONDecodeError, ValueError):
                    continue

                # Захватываем session_id
                sid = data.get("session_id")
                if sid and not self.session_id:
                    self.session_id = sid
                    log(f"Daemon {self.name}: session_id={sid}")
                    _save_session(self.name, sid)
                    # Обновляем agent_init в логе с реальным session_id
                    with open(log_file, "a") as lf:
                        lf.write(json.dumps({"type": "agent_init", "agent": self.name, "session_id": sid}) + "\n")

                # result означает что агент закончил обработку текущего сообщения
                if data.get("type") == "result":
                    cost = data.get("total_cost_usd", 0)
                    self._total_cost += cost
                    self._message_count += 1
                    log(f"Daemon {self.name}: result (${cost:.4f}, total=${self._total_cost:.4f}, msgs={self._message_count})")
                    self._idle.set()

        except Exception as e:
            log(f"Daemon {self.name}: ошибка чтения stdout: {e}")
        finally:
            if proc.stdout:
                proc.stdout.close()
            log(f"Daemon {self.name}: stdout reader завершён")

    def _worker_loop(self):
        """Последовательно отправляет сообщения из очереди."""
        while True:
            # Ждём пока появится сообщение в очереди
            while True:
                with self._queue_lock:
                    if self._queue:
                        msg = self._queue.pop(0)
                        break
                time.sleep(0.5)

            # Ждём пока агент освободится
            self._idle.wait(timeout=600)

            # Отправляем сообщение
            self._send_raw(msg)

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

        self._idle.clear()
        try:
            proc.stdin.write(message_json + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            log(f"Daemon {self.name}: ошибка записи в stdin: {e}, перезапуск")
            self._idle.set()
            with self.lock:
                self.proc = None
            self.ensure_running()
            # Повторная попытка
            with self.lock:
                proc = self.proc
            self._idle.clear()
            try:
                proc.stdin.write(message_json + "\n")
                proc.stdin.flush()
            except Exception as e2:
                log(f"Daemon {self.name}: повторная ошибка записи: {e2}")
                self._idle.set()

    def send_message(self, text: str):
        """Ставит сообщение в очередь агента."""
        msg = json.dumps({
            "type": "user",
            "message": {"role": "user", "content": text},
        })
        with self._queue_lock:
            self._queue.append(msg)
        log(f"Daemon {self.name}: сообщение в очереди (размер: {len(self._queue)})")

    def get_rss_mb(self) -> float | None:
        """Возвращает RSS памяти процесса в MB, или None."""
        if not self.proc or self.proc.poll() is not None:
            return None
        try:
            with open(f"/proc/{self.proc.pid}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        return int(line.split()[1]) / 1024
        except (FileNotFoundError, ValueError, ProcessLookupError):
            return None

    def interrupt(self):
        """Прерывает текущую операцию агента (SIGINT дочернему bash-процессу)."""
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                return False
            pid = self.proc.pid
        # Ищем дочерний bash-процесс (tool use)
        try:
            children = [
                int(p) for p in os.listdir("/proc")
                if p.isdigit() and os.path.isfile(f"/proc/{p}/stat")
            ]
            for cpid in children:
                try:
                    with open(f"/proc/{cpid}/stat") as f:
                        stat = f.read().split()
                        ppid = int(stat[3])
                        comm = stat[1].strip("()")
                    if ppid == pid and comm == "bash":
                        os.kill(cpid, signal.SIGINT)
                        log(f"Daemon {self.name}: SIGINT -> bash child PID {cpid}")
                        return True
                except (FileNotFoundError, ProcessLookupError, ValueError, IndexError):
                    continue
        except Exception as e:
            log(f"Daemon {self.name}: ошибка поиска child: {e}")
        log(f"Daemon {self.name}: дочерний bash-процесс не найден")
        return False

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
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.proc.wait()
            log(f"Daemon {self.name} остановлен (session_id={self.session_id} сохранён для resume)")
            self.proc = None


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
    """Возвращает (или создаёт) daemon для агента, подгружая session_id из файла."""
    with agent_daemons_lock:
        if agent not in agent_daemons:
            daemon = AgentDaemon(agent)
            saved_sid = _load_sessions().get(agent)
            if saved_sid:
                daemon.session_id = saved_sid
                log(f"Daemon {agent}: загружен session_id={saved_sid} из sessions.json")
            agent_daemons[agent] = daemon
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
# Worktree management
# ---------------------------------------------------------------------------

def setup_worktree(key):
    """Создаёт git worktree для задачи, возвращает путь."""
    branch = f"feature/{key}"
    worktree_path = os.path.join(PROJECT_DIR, ".worktrees", key)
    if os.path.isdir(worktree_path):
        return worktree_path
    os.makedirs(os.path.dirname(worktree_path), exist_ok=True)
    subprocess.run(["git", "branch", "-f", branch, "main"], cwd=PROJECT_DIR, capture_output=True)
    result = subprocess.run(
        ["git", "worktree", "add", worktree_path, branch],
        cwd=PROJECT_DIR, capture_output=True, text=True,
    )
    if result.returncode != 0:
        log(f"Ошибка worktree для {key}: {result.stderr.strip()}")
        return PROJECT_DIR
    log(f"Worktree создан: {worktree_path} ({branch})")

    env_src = os.path.join(PROJECT_DIR, ".env")
    env_dst = os.path.join(worktree_path, ".env")
    if os.path.isfile(env_src) and not os.path.exists(env_dst):
        import shutil
        shutil.copy2(env_src, env_dst)
        log(f".env скопирован в {worktree_path}")

    for subdir in ["", "apps/web", "apps/api"]:
        src = os.path.join(PROJECT_DIR, subdir, "node_modules") if subdir else os.path.join(PROJECT_DIR, "node_modules")
        dst = os.path.join(worktree_path, subdir, "node_modules") if subdir else os.path.join(worktree_path, "node_modules")
        if os.path.isdir(src) and not os.path.exists(dst):
            if subdir:
                os.makedirs(os.path.join(worktree_path, subdir), exist_ok=True)
            os.symlink(src, dst)
            log(f"Симлинк: {dst} -> {src}")

    return worktree_path


def cleanup_worktree(key: str):
    """Удаляет git worktree задачи."""
    worktree_path = os.path.join(PROJECT_DIR, ".worktrees", key)
    if not os.path.isdir(worktree_path):
        return
    result = subprocess.run(
        ["git", "worktree", "remove", "--force", worktree_path],
        cwd=PROJECT_DIR, capture_output=True, text=True,
    )
    if result.returncode == 0:
        log(f"Worktree удалён: {worktree_path}")
    else:
        log(f"Ошибка удаления worktree {worktree_path}: {result.stderr.strip()}")


def cleanup_stale_worktrees():
    """Фоновый цикл: чистит worktrees задач, перешедших в Done."""
    worktrees_dir = os.path.join(PROJECT_DIR, ".worktrees")
    while True:
        time.sleep(300)  # каждые 5 минут
        if not os.path.isdir(worktrees_dir):
            continue
        for name in os.listdir(worktrees_dir):
            if not name.startswith("KS-"):
                continue
            path = os.path.join(worktrees_dir, name)
            if not os.path.isdir(path):
                continue
            sc = _get_issue_status_category(name)
            if sc == "done":
                log(f"Worktree cleanup: {name} в статусе Done")
                cleanup_worktree(name)


# ---------------------------------------------------------------------------
# Отправка сообщений агентам
# ---------------------------------------------------------------------------

def send_to_agent(agent: str, prompt: str):
    """Отправляет сообщение daemon-агенту. Сначала прерывает текущую работу."""
    daemon = get_daemon(agent)
    daemon.interrupt()
    daemon.ensure_running()
    daemon.send_message(prompt)


def handle_agent_message(handler, payload):
    """Обрабатывает POST /agent/message — прямое сообщение между агентами."""
    sender = payload.get("from", "")
    target = payload.get("to", "")
    message = payload.get("message", "")

    if not target or not message:
        handler.send_response(400)
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": "missing 'to' or 'message'"}).encode())
        return

    valid_agents = get_valid_agents()
    if target not in valid_agents:
        handler.send_response(404)
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": f"unknown agent '{target}'"}).encode())
        return

    prefix = f"[from {sender}] " if sender else ""
    send_to_agent(target, f"{prefix}{message}")
    log(f"Agent message: {sender or '?'} -> {target} ({len(message)} chars)")

    handler.send_response(200)
    handler.end_headers()
    handler.wfile.write(json.dumps({"status": "delivered", "to": target}).encode())


def _escape_html(text: str) -> str:
    """Экранирует HTML-символы для Telegram API."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def handle_telegram_send(handler, payload):
    """Обрабатывает POST /telegram/send — агент отправляет сообщение в Telegram."""
    message = payload.get("message", "")
    if not message:
        handler.send_response(400)
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": "missing 'message'"}).encode())
        return

    send_telegram(_escape_html(message))
    log(f"Telegram send: {message[:80]}")

    handler.send_response(200)
    handler.end_headers()
    handler.wfile.write(json.dumps({"status": "sent"}).encode())


def launch_agent(key, summary, agent, prompt=None):
    """Формирует промпт и отправляет его daemon-агенту."""
    if not prompt:
        role = agent.upper()
        prompt = (
            f"Ты работаешь над задачей {key}: {summary}\n"
            f"Общайся и думай на русском языке.\n"
            f"Твоя рабочая директория: /home/pivovartsev/work/kingside/.worktrees/{key}\n"
            f"ПЕРВОЕ действие: cd /home/pivovartsev/work/kingside/.worktrees/{key}\n"
            f"ЗАПРЕЩЕНО менять файлы в /home/pivovartsev/work/kingside напрямую.\n"
            f"ЕСЛИ ОКРУЖЕНИЕ НЕ РАБОТАЕТ (dev-сервер, API, CORS, auth, модули) — НЕМЕДЛЕННО ПРЕКРАТИ РАБОТУ. "
            f"Добавь комментарий 'Окружение не готово: <проблема>. @coordinator' и ЗАВЕРШИ. Не пытайся чинить.\n\n"
            f"1. Переведи задачу в статус 'In Progress' (transitionId: 21)\n"
            f"2. Прочитай описание задачи\n"
            f"3. Выполни задачу\n"
            f"4. Коммитни изменения в ветку feature/{key}\n"
            f"5. Смержи ветку в main: git -C /home/pivovartsev/work/kingside merge feature/{key}\n"
            f"6. Добавь комментарий с результатом\n"
            f"7. Переведи задачу в статус 'Done' (transitionId: 41)"
        )

    # Для coding-агентов — создаём worktree перед отправкой
    if agent != "coordinator":
        setup_worktree(key)

    log_file = os.path.join(LOG_DIR, "agents.log")
    with open(log_file, "a") as lf:
        lf.write(json.dumps({"type": "agent_msg", "agent": agent.upper(), "task": key}) + "\n")

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


def send_telegram(text):
    """Отправляет сообщение в Telegram."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    for part in _split_message(text):
        data = urllib.parse.urlencode({
            "chat_id": TELEGRAM_CHAT_ID,
            "text": part,
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        }).encode()
        try:
            req = urllib.request.Request(url, data=data)
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            log(f"Ошибка отправки в Telegram: {e}")


def format_telegram_issue(event_type, payload):
    """Форматирует событие трекера в текст для Telegram."""
    issue = payload.get("issue", {})
    key = issue.get("key", payload.get("issue_key", "?"))
    summary = issue.get("summary", "")
    status = issue.get("status", "")
    assignee = issue.get("assignee", "не назначен") or "не назначен"

    if event_type == "issue_created":
        return (
            f"🆕 <b>Создана задача</b>\n"
            f"{key}: {summary}\n"
            f"Статус: {status}\n"
            f"Исполнитель: {assignee}"
        )

    if event_type == "issue_updated":
        return (
            f"✏️ <b>Обновлена задача</b>\n"
            f"{key}: {summary}\n"
            f"Статус: {status}\n"
            f"Исполнитель: {assignee}"
        )

    if event_type == "issue_transitioned":
        return (
            f"🔄 <b>Смена статуса</b>\n"
            f"{key}: {summary}\n"
            f"Статус: {status}"
        )

    if event_type == "comment_added":
        comment = payload.get("comment", {})
        comment_author = comment.get("author", "")
        comment_body = comment.get("body", "")
        return (
            f"💬 <b>Новый комментарий</b>\n"
            f"{key}: {summary}\n"
            f"Автор: {comment_author}\n"
            f"{comment_body}"
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
            text = message.get("text", "")
            chat = message.get("chat", {})
            chat_id = str(chat.get("id", ""))
            from_user = message.get("from", {})
            username = from_user.get("username", "")
            first_name = from_user.get("first_name", "")
            display = f"@{username}" if username else first_name

            if not text:
                continue

            if TELEGRAM_CHAT_ID and chat_id != TELEGRAM_CHAT_ID:
                continue

            log(f"Telegram сообщение от {display}: {text[:100]}")

            # Определяем целевого агента: @agent в начале или coordinator по умолчанию
            valid_agents = get_valid_agents()
            target_agent = "coordinator"
            agent_msg = text
            match = re.match(r"^@(\w+)\s+", text)
            if match and match.group(1).lower() in valid_agents:
                target_agent = match.group(1).lower()
                agent_msg = text[match.end():]

            prompt_text = f"[Telegram {display}] {agent_msg}"
            _log_user_prompt(target_agent, prompt_text, source=f"Telegram {display}")
            send_to_agent(target_agent, prompt_text)
            log(f"Telegram -> {target_agent}: {agent_msg[:80]}")
            send_telegram(f"✅ Сообщение отправлено агенту {target_agent}")


def _log_user_prompt(agent: str, text: str, source: str = "web"):
    """Записывает пользовательский промпт в agents.log для отображения в /logs."""
    log_file = os.path.join(LOG_DIR, "agents.log")
    with open(log_file, "a") as lf:
        lf.write(json.dumps({
            "type": "user_prompt",
            "agent": agent,
            "text": text,
            "source": source,
        }) + "\n")


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
        params = []
        for k, v in inp.items():
            vs = str(v)
            if len(vs) > 100:
                vs = vs[:100] + "..."
            params.append(f'<span class="tool-param-key">{_esc(k)}</span>=<span class="tool-param-val">{_esc(vs)}</span>')
        params_html = ", ".join(params)
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

    if t == "user_prompt":
        agent = data.get("agent", "")
        text = data.get("text", "")
        source = data.get("source", "web")
        color = _agent_color(agent)
        return (
            f'<div class="ev ev-user">'
            f'<span class="badge badge-user">{_esc(source)}</span>'
            f'<span class="prompt-arrow">→</span>'
            f'<span class="badge" style="background:{color}">{_esc(agent.upper())}</span>'
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
            f'<span class="badge" style="background:{color}">{_esc(agent)}</span>'
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
            f'<span class="badge" style="background:{color}">{_esc(agent.upper())}</span>'
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
                        f'<span class="badge" style="background:{color}">{_esc(name)}</span>'
                        f'{f"<span class=task>{_esc(task)}</span>" if task else ""}'
                        f'<pre class="think-text">{_esc(text)}</pre>'
                        f'</div>'
                    )
            elif ct == "text":
                text = c.get("text", "")
                if text:
                    parts.append(
                        f'<div class="ev ev-text">'
                        f'<span class="badge" style="background:{color}">{_esc(name)}</span>'
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
                    f'<span class="badge" style="background:{color}">{_esc(name)}</span>'
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
                        f'<span class="badge" style="background:{color}">{_esc(name)}</span>'
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
            f'<span class="badge" style="background:{color}">{_esc(name)}</span>'
            f'{f"<span class=task>{_esc(task)}</span>" if task else ""}'
            f'<span class="cost">${cost:.4f}</span> готов'
            f'</div>'
        )

    return None


def _esc(text: str) -> str:
    """Экранирует HTML."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _stream_logs_sse(wfile):
    """SSE-стрим: читает agents.log и шлёт форматированные события."""
    log_file = os.path.join(LOG_DIR, "agents.log")
    agents_map = {}
    agent_sid_map = {}
    current_task_map = {}

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
                formatted = _format_log_line(data, agents_map, agent_sid_map, current_task_map)
                if formatted:
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
                formatted = _format_log_line(data, agents_map, agent_sid_map, current_task_map)
                if formatted:
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
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 14px;
         padding-bottom: 80px; }
  #log { padding: 8px; max-width: 1200px; margin: 0 auto; }
  .ev { padding: 6px 10px; margin: 2px 0; border-radius: 6px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .ev-msg { background: #1c2333; border-left: 3px solid #ffd700; }
  .ev-init { background: #0d2818; border-left: 3px solid #00ff88; }
  .ev-think { background: #161b22; border-left: 3px solid #444; }
  .ev-text { background: #161b22; border-left: 3px solid #58a6ff; }
  .ev-tool { background: #1c1e2a; border-left: 3px solid #64b5f6; }
  .ev-tool-result { background: #161b22; border-left: 3px solid #555; }
  .ev-result { background: #0d2818; border-left: 3px solid #00ff88; font-weight: 600; }
  .ev-user { background: #1a1a30; border-left: 3px solid #a371f7; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 700;
           color: #fff; letter-spacing: 0.5px; white-space: nowrap; flex-shrink: 0; }
  .badge-user { background: #6e40c9; }
  .prompt-arrow { color: #6e7681; }
  .user-text { color: #e2c5ff; font-size: 13px; white-space: pre-wrap; word-break: break-word;
               margin-top: 2px; background: none; }
  .task { color: #8b949e; font-size: 12px; flex-shrink: 0; }
  .ts { color: #484f58; font-size: 11px; font-family: monospace; flex-shrink: 0; }
  .lbl { color: #ffd700; font-weight: 600; }
  .cost { color: #f0883e; font-weight: 700; font-family: monospace; }
  .text-body { color: #c9d1d9; word-break: break-word; }
  .tool-name { color: #d2a8ff; font-weight: 600; font-family: monospace; white-space: nowrap; }
  .tool-args { color: #7d8590; font-family: monospace; font-size: 12px; word-break: break-all; }
  .tool-desc { color: #8b949e; font-style: italic; }
  .tool-path { color: #79c0ff; font-family: monospace; }
  .tool-meta { color: #6e7681; font-size: 11px; }
  .tool-cmd { color: #e6edf3; background: #161b22; padding: 2px 8px; border-radius: 4px;
              font-size: 12px; word-break: break-all; border: 1px solid #21262d; }
  .tool-code { color: #e6edf3; background: #0d1117; padding: 6px 10px; border-radius: 4px; margin-top: 4px;
               font-size: 12px; white-space: pre-wrap; word-break: break-all; border: 1px solid #21262d; }
  .tool-pattern { color: #ffa657; background: #1c1e2a; padding: 1px 6px; border-radius: 3px; }
  .tool-param-key { color: #7ee787; }
  .tool-param-val { color: #c9d1d9; }
  .diff-block { margin-top: 4px; font-family: monospace; font-size: 12px; width: 100%; }
  .diff-del { background: #3d1117; color: #ffa198; padding: 4px 8px; border-radius: 4px 4px 0 0; margin: 0;
              white-space: pre-wrap; word-break: break-all; border: 1px solid #5d1a1a; }
  .diff-add { background: #0d2818; color: #7ee787; padding: 4px 8px; border-radius: 0 0 4px 4px; margin: 0;
              white-space: pre-wrap; word-break: break-all; border: 1px solid #1a4d2e; border-top: none; }
  details { display: inline; }
  summary { cursor: pointer; color: #7d8590; font-size: 12px; font-family: monospace; }
  summary:hover { color: #c9d1d9; }
  .think-text { color: #6e7681; font-style: italic; font-size: 12px; white-space: pre-wrap; word-break: break-word;
                margin-top: 2px; background: none; }
  #status { position: fixed; top: 0; right: 0; padding: 4px 12px; background: #161b22; border-bottom-left-radius: 8px;
            font-size: 11px; color: #3fb950; border: 1px solid #21262d; z-index: 10; }
  #status.off { color: #f85149; }
  #input-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #161b22; border-top: 1px solid #21262d;
               padding: 8px 12px; display: flex; gap: 8px; align-items: center; z-index: 10; }
  #agent-select { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px;
                  padding: 6px 10px; font-size: 13px; }
  #prompt-input { flex: 1; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px;
                  padding: 8px 12px; font-size: 14px; font-family: inherit; resize: none; min-height: 38px; max-height: 300px; overflow-y: auto; }
  #prompt-input:focus { outline: none; border-color: #58a6ff; }
  #send-btn { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 8px 16px;
              font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  #send-btn:hover { background: #2ea043; }
  #send-btn:disabled { background: #21262d; color: #484f58; cursor: not-allowed; }
  #kill-btn { background: #da3633; color: #fff; border: none; border-radius: 6px; padding: 8px 16px;
              font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  #kill-btn:hover { background: #f85149; }
  #mic-btn { background: none; border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px;
             font-size: 18px; cursor: pointer; color: #8b949e; }
  #mic-btn:hover { border-color: #58a6ff; color: #58a6ff; }
  #mic-btn.recording { color: #f85149; border-color: #f85149; animation: pulse 1s infinite; background: #1a0a0a; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  #mic-status { color: #f85149; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; }
</style>
</head><body>
<div id="status">connected</div>
<div id="log"></div>
<div id="input-bar">
  <select id="agent-select">
    <option value="coordinator">coordinator</option>
    <option value="backend">backend</option>
    <option value="frontend">frontend</option>
    <option value="layout">layout</option>
    <option value="devops">devops</option>
    <option value="architect">architect</option>
  </select>
  <textarea id="prompt-input" placeholder="Сообщение агенту..." rows="1" autofocus></textarea>
  <button id="mic-btn" title="Голосовой ввод">🎤</button><span id="mic-status"></span>
  <button id="send-btn">Send</button>
  <button id="kill-btn" title="Kill agent (Esc)">Kill</button>
</div>
<script>
const log = document.getElementById('log');
const status = document.getElementById('status');
const input = document.getElementById('prompt-input');
const agentSel = document.getElementById('agent-select');
const sendBtn = document.getElementById('send-btn');

let autoScroll = true;
window.addEventListener('scroll', () => {
  autoScroll = (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100;
});

const es = new EventSource('/logs/stream');
es.onmessage = (e) => {
  const ts = new Date().toLocaleTimeString('en-GB', {hour12: false});
  const div = document.createElement('div');
  div.innerHTML = e.data.replace(/^(<div class="ev[^"]*">)/, '$1<span class="ts">' + ts + '</span>');
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
  sendBtn.disabled = true;
  try {
    const res = await fetch('/prompt', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({agent, text}),
    });
    if (res.ok) {
      input.value = '';
      input.style.height = 'auto';
    }
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

sendBtn.addEventListener('click', sendPrompt);

const killBtn = document.getElementById('kill-btn');
async function killAgent() {
  const agent = agentSel.value;
  const res = await fetch('/agent/kill', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
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
    def do_POST(self):
        path = self.path.split("?")[0]

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
                tg_text = format_telegram_issue(event, payload)
                if tg_text:
                    send_telegram(tg_text)

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
                        f"Твоя рабочая директория: /home/pivovartsev/work/kingside/.worktrees/{key}\n"
                        f"ПЕРВОЕ действие: cd /home/pivovartsev/work/kingside/.worktrees/{key}\n"
                        f"ЗАПРЕЩЕНО менять файлы в /home/pivovartsev/work/kingside напрямую.\n"
                        f"ЕСЛИ ОКРУЖЕНИЕ НЕ РАБОТАЕТ (dev-сервер, API, CORS, auth, модули) — НЕМЕДЛЕННО ПРЕКРАТИ РАБОТУ. "
                        f"Добавь комментарий 'Окружение не готово: <проблема>. @coordinator' и ЗАВЕРШИ. Не пытайся чинить.\n"
                        f"{context}\n"
                        f"Получен новый комментарий:\n{comment_text}\n\n"
                        f"1. Переведи задачу в статус 'In Progress' (transitionId: 21)\n"
                        f"2. Прочитай комментарий и выполни то, что в нём написано\n"
                        f"3. Добавь комментарий с результатом\n"
                        f"4. Смержи ветку в main: git -C /home/pivovartsev/work/kingside merge feature/{key}\n"
                        f"5. Переведи задачу в статус 'Done' (transitionId: 41)"
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
            # Переход в Done (transition_id 41) — чистим worktree
            if issue_status == "done" and key:
                threading.Thread(target=cleanup_worktree, args=(key,), daemon=True).start()

            # in_review (transition_id 31) — пока не поддерживается в трекере
            if transition_id == 31 and key:
                log(f"Задача {key}: transition_id=31 (in_review), пока не обрабатывается")

            tg_text = format_telegram_issue(event, payload)
            if tg_text:
                send_telegram(tg_text)

            log(f"Событие {event}: {key} -> {issue_status}")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "transition_handled", "key": key}).encode())
            return

        if event in ("issue_created", "issue_updated"):
            tg_text = format_telegram_issue(event, payload)
            if tg_text:
                send_telegram(tg_text)
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

        if path == "/health":
            status = {}
            with agent_daemons_lock:
                for name, daemon in agent_daemons.items():
                    status[name] = {
                        "alive": daemon.is_alive(),
                        "pid": daemon.proc.pid if daemon.proc else None,
                        "session_id": daemon.session_id,
                        "queue_size": len(daemon._queue),
                        "total_cost_usd": round(daemon._total_cost, 4),
                        "message_count": daemon._message_count,
                        "rss_mb": daemon.get_rss_mb(),
                    }
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "daemons": status}).encode())
            return

        if path == "/logs":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(LOGS_HTML.encode())
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
    # Ротация лога агентов при старте
    agents_log = os.path.join(LOG_DIR, "agents.log")
    if os.path.exists(agents_log) and os.path.getsize(agents_log) > 0:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        os.rename(agents_log, os.path.join(LOG_DIR, f"agents_{ts}.log"))
    open(agents_log, "a").close()

    # Telegram polling
    poll_thread = threading.Thread(target=telegram_poll_loop, daemon=True)
    poll_thread.start()

    # Фоновая очистка worktrees закрытых задач
    cleanup_thread = threading.Thread(target=cleanup_stale_worktrees, daemon=True)
    cleanup_thread.start()

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
