"""
KS-217: E2E верификация KS-215 — тесты для _split_message (отправка в Telegram).

Сценарии:
1. Короткое сообщение (до 200 символов) — без обрезки.
2. Длинное сообщение (200–4096 символов) — одним сообщением.
3. Очень длинное сообщение (>4096 символов) — разбивается на части.
4. Разрез по границе строки, а не посередине слова.
5. Граничный случай: ровно 4096 символов.
"""

import sys
import os
import unittest

# Добавляем корень проекта в sys.path для импорта _split_message
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# _split_message — модульная функция из webhook-server.py, но имя файла
# содержит дефис и не может быть импортировано напрямую. Используем importlib.
import importlib.util

_server_path = os.path.join(os.path.dirname(__file__), "..", "webhook-server.py")
_spec = importlib.util.spec_from_file_location("webhook_server", _server_path)
_mod = importlib.util.module_from_spec(_spec)

# webhook-server.py при импорте читает sys.argv[1] как порт и env-переменные.
# Подменяем argv и устанавливаем переменные для безопасного импорта.
_original_argv = sys.argv
sys.argv = ["webhook-server.py"]

os.environ.setdefault("JIRA_WEBHOOK_SECRET", "test")
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "")
os.environ.setdefault("TELEGRAM_CHAT_ID", "")
os.environ.setdefault("JIRA_EMAIL", "test@test.com")
os.environ.setdefault("JIRA_API_TOKEN", "test")

try:
    _spec.loader.exec_module(_mod)
except SystemExit:
    pass
finally:
    sys.argv = _original_argv

_split_message = _mod._split_message


class TestSplitMessageShort(unittest.TestCase):
    """Сценарий 1: Короткое сообщение (до 200 символов) — без обрезки."""

    def test_short_message_returned_as_single_part(self):
        msg = "Привет, это тестовое сообщение."
        result = _split_message(msg)
        self.assertEqual(result, [msg])

    def test_empty_message(self):
        result = _split_message("")
        self.assertEqual(result, [""])

    def test_single_character(self):
        result = _split_message("A")
        self.assertEqual(result, ["A"])

    def test_200_chars(self):
        msg = "A" * 200
        result = _split_message(msg)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0], msg)


class TestSplitMessageMedium(unittest.TestCase):
    """Сценарий 2: Длинное сообщение (200–4096 символов) — одним сообщением."""

    def test_500_chars_single_part(self):
        msg = "X" * 500
        result = _split_message(msg)
        self.assertEqual(len(result), 1)

    def test_4000_chars_single_part(self):
        msg = "Y" * 4000
        result = _split_message(msg)
        self.assertEqual(len(result), 1)

    def test_4095_chars_single_part(self):
        msg = "Z" * 4095
        result = _split_message(msg)
        self.assertEqual(len(result), 1)


class TestSplitMessageBoundary(unittest.TestCase):
    """Сценарий 5: Граничный случай — ровно 4096 символов."""

    def test_exactly_4096_chars_single_part(self):
        msg = "B" * 4096
        result = _split_message(msg)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0], msg)

    def test_4097_chars_splits(self):
        msg = "C" * 4097
        result = _split_message(msg)
        self.assertGreater(len(result), 1)

    def test_exactly_4096_with_newlines(self):
        # 4096 символов с переводами строк — должно остаться одним сообщением
        lines = []
        total = 0
        while total < 4090:
            line = "A" * 80 + "\n"
            lines.append(line)
            total += len(line)
        msg = "".join(lines)[:4096]
        result = _split_message(msg)
        self.assertEqual(len(result), 1)


class TestSplitMessageLong(unittest.TestCase):
    """Сценарий 3: Очень длинное сообщение (>4096) — разбивается на части."""

    def test_long_message_splits_into_multiple_parts(self):
        # Создаём сообщение ~8200 символов из строк по ~80 символов
        lines = [f"Line {i:04d}: " + "x" * 68 + "\n" for i in range(100)]
        msg = "".join(lines)
        self.assertGreater(len(msg), 4096)

        result = _split_message(msg)
        self.assertGreater(len(result), 1)

        # Каждая часть не превышает 4096 символов
        for i, part in enumerate(result):
            self.assertLessEqual(
                len(part), 4096,
                f"Часть {i} превышает 4096 символов: {len(part)}"
            )

        # Все части в сумме содержат весь исходный текст
        reassembled = "\n".join(result)
        # Допускаем потерю только символов \n на границах разреза
        for line in lines:
            stripped = line.strip()
            self.assertIn(stripped, reassembled,
                          f"Потеряна строка: {stripped[:50]}...")

    def test_each_part_within_limit(self):
        msg = "D" * 10000
        result = _split_message(msg)
        for part in result:
            self.assertLessEqual(len(part), 4096)

    def test_very_long_message_12000_chars(self):
        lines = [f"{'W' * 79}\n" for _ in range(150)]
        msg = "".join(lines)
        self.assertGreater(len(msg), 8192)

        result = _split_message(msg)
        self.assertGreater(len(result), 1)
        for part in result:
            self.assertLessEqual(len(part), 4096)


class TestSplitMessageLineBoundary(unittest.TestCase):
    """Сценарий 4: Разрез по границе строки, а не посередине слова."""

    def test_split_at_newline_not_mid_word(self):
        # Создаём текст: строки по 100 символов, чтобы разрез попал на \n
        lines = [f"Line-{i:03d} " + "a" * 90 for i in range(60)]
        msg = "\n".join(lines)
        self.assertGreater(len(msg), 4096)

        result = _split_message(msg)
        self.assertGreater(len(result), 1)

        # Каждая часть (кроме последней) должна заканчиваться полной строкой
        for i, part in enumerate(result[:-1]):
            # Проверяем, что часть не обрезает строку посередине:
            # последняя строка части должна быть одной из оригинальных строк
            last_line = part.rstrip("\n").rsplit("\n", 1)[-1]
            self.assertIn(
                last_line, lines,
                f"Часть {i} обрезана посередине строки: ...{last_line[-30:]}"
            )

    def test_split_preserves_line_integrity(self):
        # Строки разной длины
        lines = []
        for i in range(80):
            length = 50 + (i % 30)
            lines.append("Q" * length)
        msg = "\n".join(lines)
        self.assertGreater(len(msg), 4096)

        result = _split_message(msg)
        # Собираем все строки из частей
        result_lines = []
        for part in result:
            result_lines.extend(part.split("\n"))

        # Каждая строка из оригинала должна присутствовать целиком
        for line in lines:
            self.assertIn(line, result_lines,
                          f"Строка потеряна или обрезана: {line[:40]}...")

    def test_no_newline_in_text_falls_back_to_hard_cut(self):
        # Если нет переводов строк — режем по лимиту
        msg = "X" * 5000
        result = _split_message(msg)
        self.assertEqual(len(result), 2)
        self.assertEqual(len(result[0]), 4096)
        self.assertEqual(len(result[1]), 5000 - 4096)


if __name__ == "__main__":
    unittest.main()
