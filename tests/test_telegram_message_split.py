"""KS-216: Верификация исправления обрезки сообщений Telegram.

Сценарии:
1. Сообщение < 200 символов — отправляется полностью
2. Сообщение > 200 символов — отправляется полностью без обрезки
3. Сообщение > 4096 символов — разбивается на части по границе строки
4. Граничные случаи: ровно 4096, без переносов строк > 4096
"""

import sys
import os
import importlib
import unittest
from unittest.mock import patch, MagicMock

# webhook-server.py содержит дефис — используем importlib
_server_path = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "webhook-server.py",
)
spec = importlib.util.spec_from_file_location("webhook_server", _server_path)
webhook_server = importlib.util.module_from_spec(spec)

# Подставляем заглушки для переменных окружения, чтобы модуль не падал при импорте
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "")
os.environ.setdefault("TELEGRAM_CHAT_ID", "")

# Сохраняем sys.argv и подменяем, чтобы модуль не парсил аргументы тестраннера
_orig_argv = sys.argv
sys.argv = [_server_path]
spec.loader.exec_module(webhook_server)
sys.argv = _orig_argv

_split_message = webhook_server._split_message
format_telegram_issue = webhook_server.format_telegram_issue


class TestSplitMessage(unittest.TestCase):
    """Тесты функции _split_message."""

    def test_short_message_under_200_chars(self):
        """Сценарий 1: сообщение < 200 символов — одна часть."""
        text = "Короткое сообщение"
        result = _split_message(text)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0], text)

    def test_message_over_200_chars_not_truncated(self):
        """Сценарий 2: сообщение > 200 символов — не обрезается."""
        text = "A" * 300
        result = _split_message(text)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0], text)
        self.assertEqual(len(result[0]), 300)

    def test_message_over_4096_splits_at_newline(self):
        """Сценарий 3: сообщение > 4096 символов — разбивается по границе строки."""
        line = "Строка текста для тестирования\n"
        # Создаём текст чуть больше 4096 символов из строк
        text = line * (4096 // len(line) + 10)
        self.assertGreater(len(text), 4096)

        result = _split_message(text)
        self.assertGreater(len(result), 1)

        # Каждая часть ≤ 4096 символов
        for part in result:
            self.assertLessEqual(len(part), 4096)

        # Суммарно все части содержат весь текст (без потерь)
        rejoined = "\n".join(result)
        # Убираем trailing newlines для сравнения содержимого
        self.assertEqual(rejoined.replace("\n", ""), text.replace("\n", ""))

    def test_exactly_4096_chars(self):
        """Сценарий 4a: ровно 4096 символов — одна часть."""
        text = "X" * 4096
        result = _split_message(text)
        self.assertEqual(len(result), 1)
        self.assertEqual(len(result[0]), 4096)

    def test_over_4096_no_newlines(self):
        """Сценарий 4b: > 4096 символов без переносов — режет по лимиту."""
        text = "Y" * 5000
        result = _split_message(text)
        self.assertEqual(len(result), 2)
        self.assertEqual(len(result[0]), 4096)
        self.assertEqual(len(result[1]), 904)

    def test_empty_message(self):
        """Пустое сообщение."""
        result = _split_message("")
        self.assertEqual(result, [""])

    def test_multiple_splits(self):
        """Сообщение, требующее 3+ частей."""
        text = "Z" * 10000
        result = _split_message(text)
        self.assertEqual(len(result), 3)
        self.assertEqual(len(result[0]), 4096)
        self.assertEqual(len(result[1]), 4096)
        self.assertEqual(len(result[2]), 1808)


class TestCommentNotTruncated(unittest.TestCase):
    """Проверяет, что comment_created отправляет полный текст комментария."""

    def test_long_comment_not_truncated_to_200(self):
        """Комментарий > 200 символов не обрезается в format_telegram_issue."""
        long_comment = "Это длинный комментарий. " * 20  # ~500 символов
        payload = {
            "issue": {
                "key": "KS-100",
                "fields": {
                    "summary": "Тестовая задача",
                    "status": {"name": "В работе"},
                    "assignee": None,
                },
            },
            "user": {"displayName": "Тестер"},
            "comment": {
                "author": {"displayName": "Автор"},
                "body": long_comment,
            },
        }

        result = format_telegram_issue("comment_created", payload)
        self.assertIsNotNone(result)
        # Полный текст комментария присутствует (не обрезан до 200 символов)
        self.assertIn(long_comment, result)
        # Нет маркера обрезки "..."
        self.assertNotIn("...", result)

    def test_short_comment_sent_fully(self):
        """Короткий комментарий отправляется полностью."""
        comment = "Готово"
        payload = {
            "issue": {
                "key": "KS-101",
                "fields": {
                    "summary": "Задача",
                    "status": {"name": "Готово"},
                    "assignee": None,
                },
            },
            "user": {"displayName": "Тестер"},
            "comment": {
                "author": {"displayName": "Автор"},
                "body": comment,
            },
        }

        result = format_telegram_issue("comment_created", payload)
        self.assertIn(comment, result)


if __name__ == "__main__":
    unittest.main()
