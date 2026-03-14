#!/usr/bin/env python3
"""Webhook-сервер для Jira. Принимает POST от Jira и запускает соответствующего агента."""

import json
import queue
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


def extract_text_from_adf(node):
    """Рекурсивно извлекает текст из ADF (Atlassian Document Format).

    Обрабатывает все типы нод: text, mention, inlineCard, hardBreak и др.
    """
    if isinstance(node, str):
        return node

    if not isinstance(node, dict):
        return ""

    node_type = node.get("type", "")

    # Листовые ноды с текстом
    if node_type == "text":
        return node.get("text", "")
    if node_type == "mention":
        # mention ноды хранят текст в "text" (напр. "@coordinator")
        # или id в "attrs.id" / "attrs.text"
        text = node.get("text", "")
        if not text:
            attrs = node.get("attrs", {})
            text = attrs.get("text", "")
        return text
    if node_type == "inlineCard":
        attrs = node.get("attrs", {})
        return attrs.get("url", "") or attrs.get("title", "")
    if node_type == "hardBreak":
        return "\n"
    if node_type == "emoji":
        return node.get("attrs", {}).get("shortName", "")

    # Контейнерные ноды — рекурсия по content
    parts = []
    for child in node.get("content", []):
        parts.append(extract_text_from_adf(child))

    separator = "\n" if node_type in ("doc", "paragraph", "bulletList",
                                       "orderedList", "listItem",
                                       "blockquote", "codeBlock",
                                       "table", "tableRow", "tableCell",
                                       "tableHeader", "heading") else ""
    return separator.join(parts)


def get_valid_agents():
    """Сканирует .claude/agents/ и возвращает set имён агентов."""
    agents = set()
    if os.path.isdir(AGENTS_DIR):
        for f in os.listdir(AGENTS_DIR):
            if f.endswith(".md"):
                agents.add(f[:-3])
    return agents


# Очереди задач на каждого coding-агента (coordinator без очереди)
# item: {"key": ..., "summary": ..., "agent": ..., "prompt": ...}
agent_queues: dict[str, queue.Queue] = {}
agent_queues_lock = threading.Lock()

# Задачи, которые уже есть в очереди или выполняются — для дедупликации
# key -> agent
queued_tasks: dict[str, str] = {}
queued_tasks_lock = threading.Lock()


def get_or_create_queue(agent: str) -> queue.Queue:
    with agent_queues_lock:
        if agent not in agent_queues:
            q: queue.Queue = queue.Queue()
            agent_queues[agent] = q
            t = threading.Thread(target=_agent_worker, args=(agent, q), daemon=True)
            t.start()
            log(f"Очередь и worker запущены для агента {agent}")
        return agent_queues[agent]


def _agent_worker(agent: str, q: queue.Queue):
    """Worker-поток: последовательно выполняет задачи агента из очереди."""
    while True:
        item = q.get()
        key = item["key"]
        try:
            _run_agent(item["key"], item["summary"], item["agent"], item["prompt"])
        except Exception as e:
            log(f"Worker {agent}: ошибка при запуске {key}: {e}")
        finally:
            with queued_tasks_lock:
                queued_tasks.pop(key, None)
            q.task_done()


def _get_issue_details(key: str) -> dict:
    """Возвращает description и последние комментарии задачи."""
    if not JIRA_BASE_URL or not JIRA_EMAIL or not JIRA_API_TOKEN:
        return {}
    url = f"{JIRA_BASE_URL}/rest/api/3/issue/{key}?fields=description,comment,summary"
    auth = base64.b64encode(f"{JIRA_EMAIL}:{JIRA_API_TOKEN}".encode()).decode()
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Basic {auth}")
    req.add_header("Accept", "application/json")
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read().decode())
        fields = data.get("fields", {})

        description = fields.get("description", "") or ""
        if isinstance(description, dict):
            description = extract_text_from_adf(description)

        comments_raw = fields.get("comment", {}).get("comments", [])[-5:]
        comments = []
        for c in comments_raw:
            author = c.get("author", {}).get("displayName", "")
            body = c.get("body", "")
            if isinstance(body, dict):
                body = extract_text_from_adf(body)
            comments.append(f"{author}: {body}")

        return {"description": description, "comments": comments}
    except Exception as e:
        log(f"Ошибка получения деталей {key}: {e}")
        return {}


def _get_issue_status_category(key: str) -> str:
    """Возвращает statusCategory.key задачи через Jira REST API."""
    if not JIRA_BASE_URL or not JIRA_EMAIL or not JIRA_API_TOKEN:
        return ""
    url = f"{JIRA_BASE_URL}/rest/api/3/issue/{key}?fields=status"
    auth = base64.b64encode(f"{JIRA_EMAIL}:{JIRA_API_TOKEN}".encode()).decode()
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Basic {auth}")
    req.add_header("Accept", "application/json")
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read().decode())
        return data.get("fields", {}).get("status", {}).get("statusCategory", {}).get("key", "")
    except Exception as e:
        log(f"Ошибка проверки статуса {key}: {e}")
        return ""


def _run_agent(key: str, summary: str, agent: str, prompt: str):
    """Синхронно запускает claude-агента и ждёт завершения."""
    # Проверяем актуальный статус задачи перед запуском
    # Проверяем актуальный статус задачи перед запуском
    status_category = _get_issue_status_category(key)
    if status_category in ("done", "indeterminate"):
        log(f"Пропуск {key} из очереди: задача уже в статусе '{status_category}'")
        return

    log_file = os.path.join(LOG_DIR, "agents.log")
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(log_file, "a") as lf:
        lf.write(f"\n[{ts}] === ЗАПУСК АГЕНТА: {agent.upper()} для {key} ===\n")
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)
    worktree = setup_worktree(key)
    cmd = [
        "claude", "-p", prompt,
        "--agent", agent,
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
        "--verbose",
    ]
    with open(log_file, "a") as lf:
        proc = subprocess.Popen(cmd, cwd=worktree, env=env, stdout=lf, stderr=lf)
    log(f"Агент {agent} запущен для {key} в {worktree} (PID: {proc.pid})")

    # Ждём завершения, периодически проверяя статус задачи
    check_interval = 30  # секунд между проверками Jira
    elapsed = 0
    while proc.poll() is None:
        time.sleep(5)
        elapsed += 5
        if elapsed >= check_interval:
            elapsed = 0
            sc = _get_issue_status_category(key)
            if sc == "done":
                log(f"Задача {key} закрыта (статус '{sc}'), завершаем агента {agent} (PID: {proc.pid})")
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                break

    log(f"Агент {agent} завершил {key} (код: {proc.returncode})")
    _cleanup_worktree(key)


def _cleanup_worktree(key: str):
    """Удаляет git worktree задачи после завершения агента."""
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
        # Ищем последний перевод строки в пределах лимита
        split_pos = text.rfind("\n", 0, max_len)
        if split_pos <= 0:
            # Нет переноса строки — режем по лимиту
            split_pos = max_len
        parts.append(text[:split_pos])
        text = text[split_pos:].lstrip("\n")
    return parts


def send_telegram(text):
    """Отправляет сообщение в Telegram. Не бросает исключений.

    Если текст превышает 4096 символов (лимит Telegram API),
    разбивает его на несколько сообщений по границе строки.
    """
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
            comment_body = extract_text_from_adf(comment_body)
        return (
            f"💬 <b>Новый комментарий</b>\n"
            f"<a href=\"{jira_url}\">{key}</a>: {summary}\n"
            f"Автор: {comment_author}\n"
            f"{comment_body}"
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
    """Ставит задачу в очередь агента (или запускает coordinator напрямую)."""
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

    # Coordinator — запускаем напрямую в фоне, без очереди
    if agent == "coordinator":
        log_file = os.path.join(LOG_DIR, "agents.log")
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(log_file, "a") as lf:
            lf.write(f"\n[{ts}] === ЗАПУСК АГЕНТА: COORDINATOR для {key} ===\n")
        env = os.environ.copy()
        env.pop("CLAUDECODE", None)
        cmd = [
            "claude", "-p", prompt,
            "--agent", agent,
            "--dangerously-skip-permissions",
            "--output-format", "stream-json",
            "--verbose",
        ]
        with open(log_file, "a") as lf:
            proc = subprocess.Popen(cmd, cwd=PROJECT_DIR, env=env, stdout=lf, stderr=lf)
        log(f"Агент coordinator запущен для {key} (PID: {proc.pid})")
        return

    # Coding-агенты — дедупликация и постановка в очередь
    with queued_tasks_lock:
        if key in queued_tasks:
            log(f"Пропуск {key}: уже в очереди агента {queued_tasks[key]}")
            return
        queued_tasks[key] = agent

    q = get_or_create_queue(agent)
    q.put({"key": key, "summary": summary, "agent": agent, "prompt": prompt})
    log(f"Задача {key} добавлена в очередь агента {agent} (размер очереди: {q.qsize()})")


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

        # Telegram: только комментарии от coordinator
        if event == "comment_created":
            comment_body = payload.get("comment", {}).get("body", "")
            if isinstance(comment_body, dict):
                comment_text = extract_text_from_adf(comment_body)
            else:
                comment_text = comment_body
            if comment_text.strip().startswith("COORDINATOR:"):
                tg_text = format_telegram_issue(event, payload)
                if tg_text:
                    send_telegram(tg_text)

        if event == "comment_created":
            issue = payload.get("issue", {})
            key = issue.get("key", "")
            summary = issue.get("fields", {}).get("summary", "")
            comment_body = payload.get("comment", {}).get("body", "")

            # Статус задачи: coding-агенты только для "new" (To Do), coordinator — для любого кроме "done"
            status_category = issue.get("fields", {}).get("status", {}).get("statusCategory", {}).get("key", "")
            if status_category == "done":
                log(f"Пропуск {key}: задача в статусе Done")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"skipped","reason":"done"}')
                return

            if not key or not comment_body:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"skipped"}')
                return

            # Извлекаем текст из ADF формата (dict) или используем как строку
            if isinstance(comment_body, dict):
                comment_text = extract_text_from_adf(comment_body)
            else:
                comment_text = comment_body

            # Определяем автора-агента (если комментарий начинается с "AGENT: ")
            valid_agents = get_valid_agents()
            stripped = comment_text.strip()
            author_agent = None
            for a in valid_agents:
                if stripped.startswith(a.upper() + ": "):
                    author_agent = a
                    break

            # Парсим все @agentName из текста комментария
            # Исключаем автора-агента, чтобы не запускать его повторно
            # Coding-агентов запускаем только если задача имеет их метку
            labels = [l.get("name", "").lower() if isinstance(l, dict) else l.lower()
                      for l in issue.get("fields", {}).get("labels", [])]
            mentions = re.findall(r"@(\w+)", comment_text)
            agents = []
            for m in mentions:
                name = m.lower()
                if name not in valid_agents or name == author_agent:
                    continue
                # coordinator — для любого не-done статуса
                # coding-агенты — только если задача в статусе To Do (labels в comment payload пустые — не проверяем)
                if name == "coordinator":
                    agents.append(name)
                elif status_category == "new":
                    agents.append(name)

            # Coordinator получает все комментарии (если он не автор)
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
            desc_block = f"\nОписание задачи:\n{description}\n" if description else ""

            for agent in agents:
                role = agent.upper()
                if agent != "coordinator":
                    prompt = (
                        f"Задача {key}: {summary}\n"
                        f"{desc_block}\n"
                        f"Получен новый комментарий:\n{comment_text}\n\n"
                        f"1. Переведи задачу в статус 'In Progress' через MCP jira-personal\n"
                        f"2. Прочитай комментарий и выполни то, что в нём написано\n"
                        f"3. Добавь комментарий в Jira с результатом через MCP jira-personal\n"
                        f"   Комментарий ОБЯЗАТЕЛЬНО начинай с '{role}: '\n"
                        f"4. Переведи задачу в статус 'Done'"
                    )
                else:
                    prompt = (
                        f"Задача {key}: {summary}\n"
                        f"{desc_block}\n"
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

        # Проверяем: переход в статус "В процессе проверки" → запускаем QA
        issue = payload.get("issue", {})
        key = issue.get("key", "")
        summary = issue.get("fields", {}).get("summary", "")
        changelog_items = payload.get("changelog", {}).get("items", [])
        status_to = None
        for item in changelog_items:
            if item.get("field") == "status":
                status_to = item.get("toString", "")
                break

        IN_REVIEW_STATUS = "В процессе проверки"
        if status_to == IN_REVIEW_STATUS and key:
            log(f"Задача {key} перешла в '{IN_REVIEW_STATUS}' — запускаем QA")
            details = _get_issue_details(key)
            description = details.get("description", "")
            comments = details.get("comments", [])
            comments_text = "\n".join(comments) if comments else "(нет комментариев)"
            prompt = (
                f"Задача {key}: {summary}\n\n"
                f"Описание задачи:\n{description}\n\n"
                f"Последние комментарии:\n{comments_text}\n\n"
                f"Задача переведена в статус '{IN_REVIEW_STATUS}'. Проверь выполнение:\n"
                f"1. Если есть скриншоты — проверь их визуально через jira_get_attachments\n"
                f"2. Если скриншотов нет — сделай код-ревью изменений\n"
                f"3. Вынеси вердикт: закрой задачу (Done) или верни (To Do) с комментарием @frontend"
            )
            launch_agent(key, summary, "qa", prompt)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "qa_launched", "key": key}).encode())
            return

        log(f"Событие {event}: уведомление, запуск агентов не производится")
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"status":"notified"}')

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
