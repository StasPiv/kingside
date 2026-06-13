#!/usr/bin/env python3
"""
measure-segments.py — сводный реестр длительностей сегментов и якорных слов.

Вход:
    /tmp/voiceover/KS-NNNN/segment-NNN.mp3
    /tmp/voiceover/KS-NNNN/segment-NNN.timings.json
    (опц.) /tmp/voiceover/KS-NNNN/tags.json — список тегов в порядке сегментов
    (опц.) /tmp/KS-NNNN/scene-actions.json — если присутствует, anchors вытаскиваются оттуда

Выход (stdout или --out):
    [
      {
        "idx": 1,
        "tag": "play-page",
        "file": "/tmp/voiceover/KS-4062/segment-001.mp3",
        "durMs": 18416,
        "characters": 412,
        "anchors": [
          {"text": "Пуля", "atMs": 1230},
          {"text": "Блиц", "atMs": 2410}
        ]
      },
      ...
    ]

Зависимости: ffprobe (системно).
"""
from __future__ import annotations

import argparse
import glob
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional


def die(msg: str, code: int = 1) -> None:
    print(f"[measure-segments] ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def info(msg: str) -> None:
    print(f"[measure-segments] {msg}", file=sys.stderr)


def ffprobe_duration_ms(mp3: Path) -> int:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(mp3),
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.PIPE, text=True).strip()
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffprobe failed for {mp3}: {e.stderr}") from e
    try:
        return int(round(float(out) * 1000))
    except ValueError:
        raise RuntimeError(f"ffprobe non-numeric duration: {out!r}")


def anchor_to_ms(timings: dict, anchor: str) -> Optional[int]:
    chars = timings.get("characters") or []
    starts = timings.get("character_start_times_seconds") or []
    if not chars or not starts:
        return None
    text = "".join(chars)
    idx = text.find(anchor)
    if idx < 0:
        return None
    if idx >= len(starts):
        return None
    return int(round(starts[idx] * 1000))


def load_anchors_from_scene_actions(scene_actions_path: Path, tag: str) -> list[str]:
    if not scene_actions_path.exists():
        return []
    try:
        data = json.loads(scene_actions_path.read_text(encoding="utf-8"))
    except Exception as e:
        info(f"WARN: cannot read {scene_actions_path}: {e}")
        return []
    # допускаем оба формата: список сцен или {"scenes": [...]}
    if isinstance(data, dict):
        scenes = data.get("scenes", [])
    elif isinstance(data, list):
        scenes = data
    else:
        return []
    out: list[str] = []
    for scene in scenes:
        if not isinstance(scene, dict):
            continue
        if scene.get("tag") != tag:
            continue
        for a in scene.get("actions", []):
            anchor = a.get("anchor")
            if anchor:
                out.append(anchor)
    return out


def main() -> int:
    p = argparse.ArgumentParser(description="Замер длительностей сегментов")
    p.add_argument("--dir", required=True, help="директория /tmp/voiceover/KS-NNNN/")
    p.add_argument("--scene-actions", default=None,
                   help="путь к scene-actions.json (если есть — вытащим anchors)")
    p.add_argument("--tags", default=None,
                   help="путь к tags.json — список тегов в порядке сегментов "
                        "(если опущен, ищется <dir>/tags.json)")
    p.add_argument("--out", default=None,
                   help="куда писать segments.json (по умолчанию — stdout)")
    args = p.parse_args()

    dir_path = Path(args.dir).expanduser().resolve()
    if not dir_path.is_dir():
        die(f"директория не найдена: {dir_path}")

    mp3s = sorted(glob.glob(str(dir_path / "segment-*.mp3")))
    if not mp3s:
        die(f"не найдено segment-*.mp3 в {dir_path}")

    # tags
    tags_path = Path(args.tags) if args.tags else dir_path / "tags.json"
    tags: list[str] = []
    if tags_path.exists():
        try:
            tags = json.loads(tags_path.read_text(encoding="utf-8"))
            if not isinstance(tags, list):
                info(f"WARN: {tags_path} не массив, игнор")
                tags = []
        except Exception as e:
            info(f"WARN: cannot read {tags_path}: {e}")

    scene_actions_path = Path(args.scene_actions) if args.scene_actions else None

    result: list[dict] = []
    for mp3_str in mp3s:
        mp3 = Path(mp3_str)
        m = re.search(r"segment-(\d+)\.mp3$", mp3.name)
        if not m:
            continue
        idx = int(m.group(1))
        tag = tags[idx - 1] if 0 < idx <= len(tags) else None

        try:
            dur_ms = ffprobe_duration_ms(mp3)
        except RuntimeError as e:
            info(f"FAIL {mp3.name}: {e}")
            continue

        timings_path = mp3.parent / (mp3.stem + ".timings.json")
        timings: dict = {}
        if timings_path.exists():
            try:
                timings = json.loads(timings_path.read_text(encoding="utf-8"))
            except Exception as e:
                info(f"WARN cannot read {timings_path}: {e}")

        anchors: list[dict] = []
        if scene_actions_path and tag:
            for a in load_anchors_from_scene_actions(scene_actions_path, tag):
                at = anchor_to_ms(timings, a)
                anchors.append({"text": a, "atMs": at})

        entry = {
            "idx": idx,
            "tag": tag,
            "file": str(mp3),
            "durMs": dur_ms,
            "characters": len(timings.get("characters") or []),
        }
        if anchors:
            entry["anchors"] = anchors
        result.append(entry)

    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload, encoding="utf-8")
        info(f"segments → {args.out}")
    else:
        sys.stdout.write(payload + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
