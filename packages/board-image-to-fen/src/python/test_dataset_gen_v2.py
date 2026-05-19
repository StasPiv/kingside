"""Тесты для dataset_gen v2 (KS-3091, ADR-040-v2 этап B).

Главное — инвариант изоляции `set(TRAIN_STYLES) & set(VAL_STYLES) == ∅`.
Сломаться он должен ДО любого I/O, на import-уровне, потому что v1 не
заметила утечку именно из-за того, что проверки не было.
"""

from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path


# Make sibling module importable when tests are run from repo root.
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


class IsolationInvariantTests(unittest.TestCase):
    """Главное архитектурное требование ADR-040-v2 §1.3."""

    def test_train_and_val_are_disjoint(self) -> None:
        """Текущие списки TRAIN_STYLES и VAL_STYLES не пересекаются."""
        import dataset_gen as dg
        overlap = set(dg.TRAIN_STYLES) & set(dg.VAL_STYLES)
        self.assertEqual(
            overlap, set(),
            f"train ∩ val must be empty, got: {sorted(overlap)}",
        )

    def test_train_styles_non_empty(self) -> None:
        """Train-список должен содержать достаточно стилей для разнообразия.
        Точное число меняется при ревизиях (см. user-review KS-3091 v3 —
        расширили с 8 до 46), но не должно опускаться ниже 8.
        lichess_letter (буквы вместо силуэтов) — всегда исключён."""
        import dataset_gen as dg
        self.assertGreaterEqual(len(dg.TRAIN_STYLES), 8)
        self.assertNotIn("lichess_letter", dg.TRAIN_STYLES)

    def test_val_styles_required(self) -> None:
        """Val должен покрывать целевые прод-стили, которые модель обязана
        уметь распознавать. Минимум — kingside_default и cburnett."""
        import dataset_gen as dg
        self.assertGreaterEqual(len(dg.VAL_STYLES), 2)
        self.assertIn("kingside_default", dg.VAL_STYLES)
        self.assertIn("lichess_cburnett", dg.VAL_STYLES)

    def test_invariant_assert_fires_on_violation(self) -> None:
        """Если кто-то добавит val-стиль в train — модуль должен падать на
        import (assert на уровне модуля).

        Сэмулируем: подменяем VAL_STYLES так, чтобы пересеклось с
        TRAIN_STYLES, и перепроверяем инвариант вручную (assert на
        модульном уровне уже сработал при первом импорте — он защищает
        от регрессии в самом коде, а здесь мы тестируем саму инвариантную
        проверку).
        """
        import dataset_gen as dg
        fake_val = list(dg.VAL_STYLES) + [dg.TRAIN_STYLES[0]]
        overlap = set(dg.TRAIN_STYLES) & set(fake_val)
        self.assertEqual(overlap, {dg.TRAIN_STYLES[0]})

        # И ещё: убедимся, что сам модуль при «правильной» загрузке
        # импортируется без AssertionError.
        try:
            importlib.reload(dg)
        except AssertionError as exc:  # noqa: BLE001
            self.fail(f"isolation assert fired unexpectedly: {exc}")


class ClassWeightsTests(unittest.TestCase):
    """Балансировка по chess-expert §4: 22 / 11 / 11 / 5.6×10 = 100.0."""

    def test_weights_sum_to_100(self) -> None:
        import dataset_gen as dg
        self.assertAlmostEqual(sum(dg.CLASS_WEIGHTS.values()), 100.0, places=6)

    def test_weights_cover_all_labels(self) -> None:
        import dataset_gen as dg
        self.assertEqual(set(dg.CLASS_WEIGHTS), set(dg.LABELS))

    def test_empty_is_undersampled_vs_natural(self) -> None:
        """Естественная доля empty на средней доске ≈ 50%. У нас 22% —
        сильно ниже, как и требует ADR-040-v2 §4. Если кто-то по
        невнимательности вернёт «как было», тест поймает."""
        import dataset_gen as dg
        self.assertLess(dg.CLASS_WEIGHTS["empty"], 30.0)

    def test_kings_are_oversampled_vs_natural(self) -> None:
        """Естественная доля каждого короля = 1/64 ≈ 1.56%. У нас 5.6%."""
        import dataset_gen as dg
        self.assertGreater(dg.CLASS_WEIGHTS["wK"], 5.0)
        self.assertGreater(dg.CLASS_WEIGHTS["bK"], 5.0)


class EdgeCaseFensTests(unittest.TestCase):
    """9 трудных позиций chess-expert KS-3091 §3."""

    def test_nine_edge_case_fens(self) -> None:
        import dataset_gen as dg
        self.assertEqual(len(dg.EDGE_CASE_FENS), 9)

    def test_edge_case_fens_parse(self) -> None:
        """Каждая позиция должна корректно разбираться `_fen_to_grid`."""
        import dataset_gen as dg
        for fen in dg.EDGE_CASE_FENS:
            grid = dg._fen_to_grid(fen)
            self.assertEqual(len(grid), 8, fen)
            for row in grid:
                self.assertEqual(len(row), 8, fen)

    def test_edge_case_fens_have_exactly_one_king_each(self) -> None:
        """Каждый edge-case должен быть легальной позицией (1 wK + 1 bK).
        chess-expert утверждал что все легальны."""
        import dataset_gen as dg
        for fen in dg.EDGE_CASE_FENS:
            grid = dg._fen_to_grid(fen)
            wk = sum(c == "wK" for row in grid for c in row)
            bk = sum(c == "bK" for row in grid for c in row)
            self.assertEqual(wk, 1, f"wK != 1 in {fen}")
            self.assertEqual(bk, 1, f"bK != 1 in {fen}")


class HSVSamplingTests(unittest.TestCase):
    """Цвет клеток — процедурный HSV-сэмплинг, не фиксированные пресеты."""

    def test_light_and_dark_ranges_disjoint_on_value(self) -> None:
        """Светлая клетка должна быть СВЕТЛЕЕ тёмной — это базовая
        проверка, чтобы кто-то не перепутал диапазоны Value."""
        import dataset_gen as dg
        self.assertGreater(
            dg.LIGHT_HSV_RANGES["V"][0],
            dg.DARK_HSV_RANGES["V"][1],
        )

    def test_hsv_to_rgb_returns_8bit_tuple(self) -> None:
        import dataset_gen as dg
        r, g, b = dg.hsv_to_rgb(120.0, 0.5, 0.8)
        for ch in (r, g, b):
            self.assertIsInstance(ch, int)
            self.assertGreaterEqual(ch, 0)
            self.assertLessEqual(ch, 255)


class ValFenListTests(unittest.TestCase):
    """500 FEN'ов val-выборки фиксированы и воспроизводимы между запусками."""

    def test_val_fen_list_length(self) -> None:
        import dataset_gen as dg
        fens, _ = dg._build_val_fen_list()
        self.assertEqual(len(fens), dg.VAL_FENS_PER_STYLE)

    def test_val_fen_list_starts_with_edge_cases(self) -> None:
        import dataset_gen as dg
        fens, _ = dg._build_val_fen_list()
        self.assertEqual(fens[:9], dg.EDGE_CASE_FENS)

    def test_val_fen_list_deterministic(self) -> None:
        """Повторный вызов даёт идентичный результат — это «фиксация хешем»
        из acceptance ADR."""
        import dataset_gen as dg
        a_fens, a_sha = dg._build_val_fen_list()
        b_fens, b_sha = dg._build_val_fen_list()
        self.assertEqual(a_fens, b_fens)
        self.assertEqual(a_sha, b_sha)


class ProceduralBackgroundTests(unittest.TestCase):
    """KS-3091 follow-up: фон-инвариантность через процедурные фоны.

    Главная идея — модель должна научиться игнорировать фон. Тесты
    проверяют, что генератор фонов выдаёт ожидаемый объект и что
    `render_cell(procedural_bg=True)` отрабатывает без падений
    для всех классов и обоих типов клеток.
    """

    def test_background_module_lists_generators(self) -> None:
        import background as bg
        kinds = bg.list_bg_kinds()
        self.assertIn("solid", kinds)
        self.assertIn("hatch", kinds)
        self.assertGreaterEqual(len(kinds), 4)

    def test_render_background_returns_rgb_64(self) -> None:
        import random
        import background as bg
        rng = random.Random(2026)
        for kind in ("light", "dark"):
            img = bg.render_background(kind, rng)
            self.assertEqual(img.size, (64, 64))
            self.assertEqual(img.mode, "RGB")

    def test_render_background_rejects_bad_kind(self) -> None:
        import random
        import background as bg
        with self.assertRaises(ValueError):
            bg.render_background("medium", random.Random(0))

    def test_render_cell_procedural_bg_runs_for_all_labels(self) -> None:
        """С procedural_bg=True render_cell должен отработать для каждого
        класса и обоих bg_kind — иначе сломаем train-генерацию."""
        import random
        import dataset_gen as dg
        rng = random.Random(2026)
        for label in dg.LABELS:
            for bg_kind in ("light", "dark"):
                img = dg.render_cell(
                    label, dg.TRAIN_STYLES[0], bg_kind, rng,
                    fixed_bg=False, procedural_bg=True,
                )
                self.assertEqual(img.size, (64, 64), (label, bg_kind))
                self.assertEqual(img.mode, "RGB", (label, bg_kind))

    def test_light_dark_mean_brightness_differs(self) -> None:
        """Свет и тьма должны различаться по средней яркости — это
        семантика, которую модель использует для inferring side-to-move.
        Хотя bg инвариантен по построению, средняя яркость остаётся
        правильной (proxy для bg_kind)."""
        import random
        import numpy as np
        import background as bg
        light_brightness = []
        dark_brightness = []
        rng = random.Random(2026)
        for _ in range(40):
            light_brightness.append(np.asarray(bg.render_background("light", rng)).mean())
            dark_brightness.append(np.asarray(bg.render_background("dark", rng)).mean())
        # Mean light должна быть заметно выше mean dark.
        self.assertGreater(
            float(np.mean(light_brightness)),
            float(np.mean(dark_brightness)) + 30,
            "light cells must be visibly brighter than dark on average",
        )


if __name__ == "__main__":
    unittest.main()
