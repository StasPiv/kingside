#!/usr/bin/env python3
"""Webhook-сервер для Jira. Принимает POST от Jira и запускает соответствующего агента."""

import json
import re
import subprocess
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(PROJECT_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9876

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
        prompt = (
            f"Ты работаешь над задачей {key}: {summary}\n\n"
            f"1. Сначала переведи задачу в статус 'In Progress' через MCP jira-personal\n"
            f"2. Прочитай описание задачи из Jira\n"
            f"3. Выполни задачу\n"
            f"4. Коммитни изменения в ветку feature/{key}\n"
            f"5. Смержи ветку в main: git checkout main && git merge feature/{key}\n"
            f"6. Добавь комментарий в Jira с результатом\n"
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

            # Парсим @agentName из текста комментария
            valid_agents = get_valid_agents()
            match = re.search(r"@(\w+)", comment_body)
            agent = match.group(1).lower() if match else None
            if agent and agent not in valid_agents:
                agent = None

            if not agent:
                log(f"Комментарий к {key}: нет @agent в тексте, пропуск")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"skipped"}')
                return

            prompt = (
                f"Задача {key}: {summary}\n\n"
                f"Получен новый комментарий:\n{comment_body}\n\n"
                f"1. Прочитай комментарий и выполни то, что в нём написано\n"
                f"2. Добавь комментарий в Jira с результатом через MCP jira-personal"
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
    server = HTTPServer(("127.0.0.1", PORT), WebhookHandler)
    log(f"Webhook-сервер запущен на порту {PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Webhook-сервер остановлен")
        server.server_close()
