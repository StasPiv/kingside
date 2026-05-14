#!/usr/bin/env python3
"""KS-2359 / ADR-040 Stage 1. Acceptance-раннер `board_detect.py`.

Запускает детекцию на всех fixtures (Dvoretsky PDF-extracted +
synthetic Lichess), агрегирует success rate, печатает свод. Exit 0
если общий rate ≥ 80% (ADR-040 acceptance), иначе exit 1.

Используется как замена vitest-runner'а: в backend-контейнере
`node_modules` смонтирован read-only, и `vite` падает при попытке
писать `.vite-temp/`. vitest-spec `test/board-detect.spec.ts`
оставлен для CI, где этой проблемы нет.

Запуск:
    cd packages/board-image-to-fen
    python3 test/run-board-detect-acceptance.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import List, Tuple


HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE_ROOT = os.path.dirname(HERE)
PYTHON_SCRIPT = os.path.join(PACKAGE_ROOT, 'src', 'python', 'board_detect.py')

FIXTURE_DIRS: List[Tuple[str, str]] = [
    ('dvoretsky', os.path.join(HERE, 'fixtures', 'dvoretsky')),
    ('lichess-synthetic', os.path.join(HERE, 'fixtures', 'board-detect')),
]


def _list_fixtures(directory: str) -> List[str]:
    if not os.path.isdir(directory):
        return []
    out: List[str] = []
    for name in sorted(os.listdir(directory)):
        if not name.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp')):
            continue
        path = os.path.join(directory, name)
        if os.path.getsize(path) < 1000:
            continue
        out.append(path)
    return out


def _detect(path: str) -> dict:
    res = subprocess.run(
        ['python3', PYTHON_SCRIPT, path, '--json'],
        capture_output=True,
        text=True,
        timeout=15,
    )
    try:
        return json.loads(res.stdout or '{}')
    except json.JSONDecodeError:
        return {
            'success': False,
            'method': 'failed',
            'error': f'invalid stdout: {res.stdout!r}, stderr: {res.stderr!r}',
        }


def main() -> int:
    overall_success = 0
    overall_total = 0
    failures: List[str] = []

    print('=== KS-2359 board_detect.py acceptance ===\n')

    for group, directory in FIXTURE_DIRS:
        fixtures = _list_fixtures(directory)
        if not fixtures:
            print(f'[{group}] no fixtures in {directory}, skipped\n')
            continue
        group_success = 0
        for fixture in fixtures:
            r = _detect(fixture)
            ok = bool(r.get('success'))
            method = r.get('method', '?')
            conf = r.get('confidence', 0.0)
            mark = '✓' if ok else '✗'
            print(
                f'  {mark} {os.path.basename(fixture)}: '
                f'method={method} confidence={conf:.3f}'
            )
            if ok:
                group_success += 1
                overall_success += 1
            else:
                failures.append(f'{group}/{os.path.basename(fixture)}')
            overall_total += 1
        rate = group_success / len(fixtures) if fixtures else 0
        print(
            f'[{group}] {group_success}/{len(fixtures)} = {rate * 100:.1f}%\n'
        )

    if overall_total == 0:
        print('[acceptance] no fixtures at all — cannot evaluate', file=sys.stderr)
        return 1

    rate = overall_success / overall_total
    print('=== SUMMARY ===')
    print(f'  overall: {overall_success}/{overall_total} = {rate * 100:.1f}%')
    if failures:
        print(f'  failures ({len(failures)}):')
        for f in failures:
            print(f'    - {f}')
    if rate >= 0.80:
        print(f'\n[acceptance] PASS (≥ 80% ADR-040 Stage 1 threshold)')
        return 0
    print(f'\n[acceptance] FAIL ({rate * 100:.1f}% < 80% ADR-040 Stage 1 threshold)')
    return 1


if __name__ == '__main__':
    sys.exit(main())
