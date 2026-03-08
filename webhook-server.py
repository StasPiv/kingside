#!/usr/bin/env python3
"""Webhook-сервер для Jira. Принимает POST от Jira и запускает соответствующего агента."""

import json
import re
import subprocess
import os
import sys
import time
import threading
import urllib.request
import urllib.parse
import base64
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(PROJECT_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9876

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

JIRA_BASE_URL = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
JIRA_EMAIL = os.environ.get("JIRA_EMAIL", "")
JIRA_API_TOKEN = os.environ.get("JIRA_API_TOKEN", "")
JIRA_TARGET_ISSUE = os.environ.get("JIRA_TARGET_ISSUE", "KS-118")

AGENTS_DIR = os.path.join(PROJECT_DIR, ".claude", "agents")


def get_valid_agents():
    """Сканирует .claude/agents/ и возвращает set имён агентов."""
    agents = set()
    if os.path.isdir(AGENTS_DIR):
        for f in os.listdir(AGENTS_DIR):
            if f.endswith(".md"):
                agents.add(f[:-3])
    return agents


# key -> {"agent": ..., "launched_at": ...}
LAUNCHED_PATH = os.path.join(LOG_DIR, "launched.json")


def load_launched():
    try:
        with open(LAUNCHED_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_launched(data):
    with open(LAUNCHED_PATH, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


launched = load_launched()


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with open(os.path.join(LOG_DIR, "webhook.log"), "a") as f:
        f.write(line + "\n")


def send_telegram(text):
    """Отправляет сообщение в Telegram. Не бросает исключений."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    }).encode()
    try:
        req = urllib.request.Request(url, data=data)
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log(f"Ошибка отправки в Telegram: {e}")


def format_telegram_issue(event_type, payload):
    """Форматирует Jira-событие в текст для Telegram."""
    issue = payload.get("issue", {})
    key = issue.get("key", "?")
    fields = issue.get("fields", {})
    summary = fields.get("summary", "")
    status = fields.get("status", {}).get("name", "")
    assignee = fields.get("assignee", {})
    assignee_name = assignee.get("displayName", "не назначен") if assignee else "не назначен"
    user = payload.get("user", {}).get("displayName", "")
    jira_url = f"https://staspivovartsev.atlassian.net/browse/{key}"

    if event_type == "jira:issue_created":
        return (
            f"🆕 <b>Создана задача</b>\n"
            f"<a href=\"{jira_url}\">{key}</a>: {summary}\n"
            f"Статус: {status}\n"
            f"Исполнитель: {assignee_name}\n"
            f"Создал: {user}"
        )

    if event_type == "jira:issue_updated":
        changelog = payload.get("changelog", {}).get("items", [])
        changes = []
        for item in changelog:
            field = item.get("field", "")
            from_val = item.get("fromString", "") or ""
            to_val = item.get("toString", "") or ""
            if field == "status":
                changes.append(f"Статус: {from_val} → {to_val}")
            elif field == "assignee":
                changes.append(f"Исполнитель: {from_val or '—'} → {to_val or '—'}")
            elif field == "priority":
                changes.append(f"Приоритет: {from_val} → {to_val}")
            elif field == "labels":
                changes.append(f"Метки: {from_val or '—'} → {to_val or '—'}")
        changes_text = "\n".join(changes) if changes else "обновлены поля"
        return (
            f"✏️ <b>Обновлена задача</b>\n"
            f"<a href=\"{jira_url}\">{key}</a>: {summary}\n"
            f"{changes_text}\n"
            f"Изменил: {user}"
        )

    if event_type == "comment_created":
        comment_author = payload.get("comment", {}).get("author", {}).get("displayName", "")
        comment_body = payload.get("comment", {}).get("body", "")
        if isinstance(comment_body, dict):
            # ADF format — извлекаем текст
            texts = []
            for block in comment_body.get("content", []):
                for item in block.get("content", []):
                    if item.get("type") == "text":
                        texts.append(item.get("text", ""))
            comment_body = " ".join(texts)
        preview = comment_body[:200] + ("..." if len(comment_body) > 200 else "")
        return (
            f"💬 <b>Новый комментарий</b>\n"
            f"<a href=\"{jira_url}\">{key}</a>: {summary}\n"
            f"Автор: {comment_author}\n"
            f"{preview}"
        )

    return None


def extract_task(payload):
    """Извлекает key, summary, agent из Jira webhook payload."""
    issue = payload.get("issue", {})
    key = issue.get("key", "")
    fields = issue.get("fields", {})
    summary = fields.get("summary", "")
    issue_type = fields.get("issuetype", {}).get("name", "").lower()
    labels = [l.get("name", "") if isinstance(l, dict) else l
              for l in fields.get("labels", [])]

    if issue_type == "epic":
        return key, summary, None, labels

    valid_agents = get_valid_agents()
    agent = None
    for label in labels:
        if label.lower() in valid_agents:
            agent = label.lower()
            break

    return key, summary, agent, labels


def setup_worktree(key):
    """Создаёт git worktree для задачи, возвращает путь."""
    branch = f"feature/{key}"
    worktree_path = os.path.join(PROJECT_DIR, ".worktrees", key)
    if os.path.isdir(worktree_path):
        return worktree_path
    os.makedirs(os.path.dirname(worktree_path), exist_ok=True)
    subprocess.run(["git", "branch", branch], cwd=PROJECT_DIR, capture_output=True)
    result = subprocess.run(
        ["git", "worktree", "add", worktree_path, branch],
        cwd=PROJECT_DIR, capture_output=True, text=True,
    )
    if result.returncode != 0:
        log(f"Ошибка worktree для {key}: {result.stderr.strip()}")
        return PROJECT_DIR
    log(f"Worktree создан: {worktree_path} ({branch})")
    return worktree_path


def launch_agent(key, summary, agent, prompt=None):
    """Запускает claude агента в фоне."""
    log_file = os.path.join(LOG_DIR, "agents.log")
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)

    worktree = setup_worktree(key)

    if not prompt:
        role = agent.upper()
        prompt = (
            f"Ты работаешь над задачей {key}: {summary}\n\n"
            f"1. Сначала переведи задачу в статус 'In Progress' через MCP jira-personal\n"
            f"2. Прочитай описание задачи из Jira\n"
            f"3. Выполни задачу\n"
            f"4. Коммитни изменения в ветку feature/{key}\n"
            f"5. Смержи ветку в main: git checkout main && git merge feature/{key}\n"
            f"6. Добавь комментарий в Jira с результатом. Комментарий ОБЯЗАТЕЛЬНО начинай с '{role}: '\n"
            f"7. Переведи задачу в статус 'Done'"
        )

    cmd = [
        "claude", "-p", prompt,
        "--agent", agent,
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
        "--verbose",
    ]

    with open(log_file, "a") as lf:
        proc = subprocess.Popen(
            cmd, cwd=worktree, env=env,
            stdout=lf, stderr=lf,
        )
    log(f"Агент {agent} запущен для {key} в {worktree} (PID: {proc.pid})")


def add_jira_comment(issue_key, text):
    """Добавляет комментарий в Jira-задачу через REST API."""
    if not JIRA_BASE_URL or not JIRA_EMAIL or not JIRA_API_TOKEN:
        log("Jira API не настроен: пропуск добавления комментария")
        return False

    url = f"{JIRA_BASE_URL}/rest/api/3/issue/{issue_key}/comment"
    auth = base64.b64encode(f"{JIRA_EMAIL}:{JIRA_API_TOKEN}".encode()).decode()

    body = {
        "body": {
            "type": "doc",
            "version": 1,
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": text},
                        {"type": "text", "text": " "},
                        {"type": "text", "text": "@coordinator"},
                    ],
                }
            ],
        }
    }

    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization", f"Basic {auth}")
    req.add_header("Content-Type", "application/json")

    try:
        resp = urllib.request.urlopen(req, timeout=15)
        log(f"Комментарий добавлен в {issue_key} (HTTP {resp.status})")
        return True
    except Exception as e:
        log(f"Ошибка добавления комментария в {issue_key}: {e}")
        return False


def telegram_poll_loop():
    """Поллинг Telegram getUpdates — пересылает сообщения в Jira."""
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

            # Фильтруем: только сообщения из целевого чата
            if TELEGRAM_CHAT_ID and chat_id != TELEGRAM_CHAT_ID:
                continue

            log(f"Telegram сообщение от {display}: {text[:100]}")

            comment_text = f"[Telegram] {display}: {text}"
            ok = add_jira_comment(JIRA_TARGET_ISSUE, comment_text)

            if ok:
                send_telegram(f"✅ Сообщение переслано в {JIRA_TARGET_ISSUE}")
            else:
                send_telegram(f"❌ Не удалось переслать в {JIRA_TARGET_ISSUE}")


class WebhookHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        path = self.path.split("?")[0]
        if path != "/webhook/jira":
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        # Дамп сырого body для отладки
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

        event = payload.get("webhookEvent", "")
        log(f"Получен webhook: {event}")

        # Отправляем Telegram-уведомление для всех событий
        tg_text = format_telegram_issue(event, payload)
        if tg_text:
            send_telegram(tg_text)

        if event == "comment_created":
            issue = payload.get("issue", {})
            key = issue.get("key", "")
            summary = issue.get("fields", {}).get("summary", "")
            comment_body = payload.get("comment", {}).get("body", "")

            if not key or not comment_body:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"skipped"}')
                return

            # Извлекаем текст из ADF формата (dict) или используем как строку
            if isinstance(comment_body, dict):
                texts = []
                for block in comment_body.get("content", []):
                    for item in block.get("content", []):
                        if item.get("type") == "text":
                            texts.append(item.get("text", ""))
                comment_text = " ".join(texts)
            else:
                comment_text = comment_body

            # Пропускаем комментарии от агентов (начинаются с "AGENT: ")
            valid_agents = get_valid_agents()
            agent_prefixes = [a.upper() + ": " for a in valid_agents]
            stripped = comment_text.strip()
            if any(stripped.startswith(p) for p in agent_prefixes):
                log(f"Комментарий к {key}: от агента, пропуск (предотвращение цикла)")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"skipped_agent_comment"}')
                return

            # Парсим все @agentName из текста комментария
            mentions = re.findall(r"@(\w+)", comment_text)
            agents = [m.lower() for m in mentions if m.lower() in valid_agents]

            if not agents:
                log(f"Комментарий к {key}: нет @agent в тексте, пропуск")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"skipped"}')
                return

            for agent in agents:
                role = agent.upper()
                prompt = (
                    f"Задача {key}: {summary}\n\n"
                    f"Получен новый комментарий:\n{comment_text}\n\n"
                    f"1. Прочитай комментарий и выполни то, что в нём написано\n"
                    f"2. Добавь комментарий в Jira с результатом через MCP jira-personal\n"
                    f"   Комментарий ОБЯЗАТЕЛЬНО начинай с '{role}: '"
                )
                log(f"Комментарий к {key} -> агент {agent}")
                launch_agent(key, summary, agent, prompt)

            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "comment_handled", "agent": agent, "key": key}).encode())
            return

        if event not in ("jira:issue_created", "jira:issue_updated"):
            log(f"Игнорируем событие: {event}")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ignored"}')
            return

        key, summary, agent, labels = extract_task(payload)

        if not key or not agent:
            log(f"Пропуск {key}: нет подходящего label (labels={labels})")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"skipped"}')
            return

        if key in launched:
            log(f"Дубль {key}: агент уже запущен в {launched[key]['launched_at']}")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "duplicate", "key": key}).encode())
            return

        log(f"Задача {key}: {summary} -> агент {agent}")
        launched[key] = {"agent": agent, "launched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
        save_launched(launched)
        launch_agent(key, summary, agent)

        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({"status": "launched", "agent": agent, "key": key}).encode())

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        pass  # подавляем стандартный лог


if __name__ == "__main__":
    # Запускаем Telegram polling в отдельном потоке (daemon — умрёт вместе с процессом)
    poll_thread = threading.Thread(target=telegram_poll_loop, daemon=True)
    poll_thread.start()

    server = HTTPServer(("127.0.0.1", PORT), WebhookHandler)
    log(f"Webhook-сервер запущен на порту {PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Webhook-сервер остановлен")
        server.server_close()
