#!/usr/bin/env python3
"""Авто-разметка задач трекера метками через Claude Haiku.

Usage:
    python3 scripts/label-issues.py [--limit N] [--dry-run] [--overwrite]

По умолчанию:
- Обрабатывает только задачи без меток
- Haiku модель для дешёвой классификации
- Логирует прогресс, можно прервать и продолжить
"""

import json
import os
import sys
import time
import urllib.request
import urllib.parse

TRACKER = os.environ.get("TRACKER_URL", "http://localhost:8090")

LABELS = {
    # Игровой функционал
    "game": "партии, доска, ходы, chess.js, chessboard, часы",
    "puzzle": "шахматные задачи, puzzle rush, rating puzzle",
    "tournament": "турниры, арены, swiss, round-robin, brackets",
    "analysis": "анализ партий, engine-bridge, evaluation, PGN",
    "broadcast": "трансляции, lichess feed, broadcast-worker",
    "stockfish": "бот Stockfish, WASM, engine",
    # Социальное
    "chat": "чат, личные сообщения, direct messages",
    "profile": "профили пользователей, рейтинги, настройки",
    "friends": "друзья, блокировки",
    "feedback": "форма обратной связи, feedback posts",
    # Инфраструктура
    "auth": "JWT, OAuth, логин, регистрация, токены",
    "prisma": "схема БД, миграции, prisma generate",
    "redis": "кэш Redis, sessions",
    "infra": "docker, CI/CD, deploy, AWS, ECS, justfile",
    "matchmaking": "подбор соперников, matchmaker, queue",
    # UI/UX
    "lobby": "главная, лобби, список игр",
    "mobile": "мобильная вёрстка, адаптивность, мобильные баги",
    "seo": "SEO, метаданные, sitemap, Open Graph",
    "i18n": "переводы, локализация, i18next",
    "onboarding": "онбординг, туториал, первые шаги",
    # Технические
    "telegram": "Telegram бот, интеграция",
    "performance": "оптимизация, скорость, кэш, query",
    "security": "безопасность, XSS, CSRF, permissions",
    "tests": "тесты, unit, e2e, jest, vitest",
}

LABELS_LIST = ", ".join(LABELS.keys())


def api_get(path):
    req = urllib.request.Request(f"{TRACKER}{path}")
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def api_patch(path, body):
    req = urllib.request.Request(
        f"{TRACKER}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="PATCH",
    )
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def classify(summary: str, description: str) -> list[str]:
    """Вызывает claude haiku для классификации задачи."""
    import subprocess, re
    prompt = (
        f"Classify this Kingside chess platform task into 1-3 labels from: {LABELS_LIST}. "
        f"Return ONLY a JSON array, no markdown, no comments. "
        f"Task summary: {summary}\n"
        f"Task description: {(description or '')[:1000]}"
    )
    cmd = [
        "claude", "-p",
        "--model", "haiku",
        "--output-format", "text",
        "--no-session-persistence",
        prompt,
    ]
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30, cwd="/tmp", env=env,
        )
        text = result.stdout.strip()
        # Извлекаем JSON массив (может быть обёрнут в ```json ... ```)
        m = re.search(r"\[[^\]]*\]", text)
        if m:
            labels = json.loads(m.group(0))
            return [l for l in labels if l in LABELS]
    except Exception as e:
        print(f"  error: {e}", file=sys.stderr)
    return []


def process_one(idx, total, issue, dry_run):
    key = issue["key"]
    labels = classify(issue["summary"], issue.get("description", ""))
    marker = "[dry]" if dry_run else "[ok]"
    print(f"{idx}/{total} {marker} {key}: {labels}", flush=True)
    if not dry_run and labels:
        try:
            api_patch(f"/api/issues/{key}", {"labels": labels})
        except Exception as e:
            print(f"  ошибка PATCH: {e}", file=sys.stderr, flush=True)


def main():
    from concurrent.futures import ThreadPoolExecutor, as_completed
    args = sys.argv[1:]
    limit = None
    dry_run = "--dry-run" in args
    overwrite = "--overwrite" in args
    workers = 10
    if "--limit" in args:
        idx = args.index("--limit")
        limit = int(args[idx + 1])
    if "--workers" in args:
        idx = args.index("--workers")
        workers = int(args[idx + 1])

    issues = api_get("/api/issues")
    if not overwrite:
        issues = [i for i in issues if not i.get("labels")]
    print(f"К обработке: {len(issues)} задач, workers={workers}")
    if limit:
        issues = issues[:limit]
        print(f"Лимит: {limit}")

    total = len(issues)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            pool.submit(process_one, i + 1, total, issue, dry_run)
            for i, issue in enumerate(issues)
        ]
        for f in as_completed(futures):
            try:
                f.result()
            except Exception as e:
                print(f"worker error: {e}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
