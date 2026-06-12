#!/usr/bin/env python3
"""
synth-eleven.py — синтез озвучки сегментов через ElevenLabs API
с возвратом character-level timings.

Вход:
    /tmp/voiceover/KS-NNNN/segment-001.txt
    /tmp/voiceover/KS-NNNN/segment-002.txt
    ...
    + env ELEVENLABS_API_KEY
    + voice_id (CLI или config)
    + model_id (CLI или config)

Выход:
    /tmp/voiceover/KS-NNNN/segment-001.mp3
    /tmp/voiceover/KS-NNNN/segment-001.timings.json
    /tmp/voiceover/KS-NNNN/segment-001.meta.json   (для идемпотентности: hash + voice_id + model)
    ...

Формат timings.json:
    {
      "characters": ["Р", "а", "з", ...],
      "character_start_times_seconds": [0.012, 0.094, ...],
      "character_end_times_seconds":   [0.094, 0.155, ...]
    }

Примеры:
    # синтез всех сегментов
    synth-eleven.py --dir /tmp/voiceover/KS-4062

    # только один сегмент
    synth-eleven.py --dir /tmp/voiceover/KS-4062 --segment 8

    # с явным голосом и моделью
    synth-eleven.py --dir /tmp/voiceover/KS-4062 \\
        --voice-id 21m00Tcm4TlvDq8ikWAM \\
        --model eleven_multilingual_v2

    # форсировать пересинтез даже при совпадении хеша
    synth-eleven.py --dir /tmp/voiceover/KS-4062 --force

Зависимости: только stdlib (urllib, json, hashlib, base64).
"""
from __future__ import annotations

import argparse
import base64
import glob
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

API_BASE = "https://api.elevenlabs.io"
DEFAULT_VOICE_ID = "TUQNWEvVPBLzMBSVDPUA"   # серийный голос видеообзоров (KS-4062)
DEFAULT_MODEL_ID = "eleven_multilingual_v2"
DEFAULT_STABILITY = 0.5
DEFAULT_SIMILARITY = 0.75
DEFAULT_STYLE = 0.0
DEFAULT_USE_SPEAKER_BOOST = True


def die(msg: str, code: int = 1) -> None:
    print(f"[synth-eleven] ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def info(msg: str) -> None:
    print(f"[synth-eleven] {msg}", file=sys.stderr)


def find_segments(dir_path: Path, only_idx: Optional[int]) -> list[Path]:
    pattern = str(dir_path / "segment-*.txt")
    files = sorted(glob.glob(pattern))
    out: list[Path] = []
    for f in files:
        m = re.search(r"segment-(\d+)\.txt$", f)
        if not m:
            continue
        idx = int(m.group(1))
        if only_idx is not None and idx != only_idx:
            continue
        out.append(Path(f))
    return out


def text_hash(text: str, voice_id: str, model_id: str) -> str:
    h = hashlib.sha256()
    h.update(text.encode("utf-8"))
    h.update(b"\0")
    h.update(voice_id.encode("utf-8"))
    h.update(b"\0")
    h.update(model_id.encode("utf-8"))
    return h.hexdigest()


def need_resynth(seg_txt: Path, voice_id: str, model_id: str, force: bool) -> tuple[bool, str]:
    text = seg_txt.read_text(encoding="utf-8").strip()
    digest = text_hash(text, voice_id, model_id)
    if force:
        return True, digest
    meta_path = seg_txt.with_suffix(".meta.json")
    mp3_path = seg_txt.with_suffix(".mp3")
    timings_path = seg_txt.parent / (seg_txt.stem + ".timings.json")
    if not (meta_path.exists() and mp3_path.exists() and timings_path.exists()):
        return True, digest
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return True, digest
    if meta.get("hash") != digest:
        return True, digest
    return False, digest


def call_elevenlabs(
    text: str,
    api_key: str,
    voice_id: str,
    model_id: str,
    stability: float,
    similarity: float,
    style: float,
    use_speaker_boost: bool,
    timeout_s: int,
) -> dict:
    url = f"{API_BASE}/v1/text-to-speech/{voice_id}/with-timestamps"
    payload = {
        "text": text,
        "model_id": model_id,
        "voice_settings": {
            "stability": stability,
            "similarity_boost": similarity,
            "style": style,
            "use_speaker_boost": use_speaker_boost,
        },
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise RuntimeError(f"ElevenLabs HTTP {e.code}: {err_body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"ElevenLabs network error: {e}") from e
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"ElevenLabs non-JSON response: {raw[:200]!r}") from e


def write_outputs(
    seg_txt: Path,
    resp: dict,
    digest: str,
    voice_id: str,
    model_id: str,
) -> tuple[Path, Path, Path]:
    audio_b64 = resp.get("audio_base64")
    if not audio_b64:
        raise RuntimeError(f"response missing audio_base64: keys={list(resp.keys())}")
    audio_bytes = base64.b64decode(audio_b64)

    alignment = resp.get("alignment") or resp.get("normalized_alignment")
    if not alignment:
        raise RuntimeError(f"response missing alignment: keys={list(resp.keys())}")

    timings = {
        "characters": alignment.get("characters", []),
        "character_start_times_seconds": alignment.get("character_start_times_seconds", []),
        "character_end_times_seconds": alignment.get("character_end_times_seconds", []),
    }
    if "normalized_alignment" in resp:
        timings["normalized_alignment"] = resp["normalized_alignment"]

    mp3_path = seg_txt.with_suffix(".mp3")
    timings_path = seg_txt.parent / (seg_txt.stem + ".timings.json")
    meta_path = seg_txt.with_suffix(".meta.json")

    mp3_path.write_bytes(audio_bytes)
    timings_path.write_text(json.dumps(timings, ensure_ascii=False), encoding="utf-8")
    meta_path.write_text(
        json.dumps(
            {
                "hash": digest,
                "voice_id": voice_id,
                "model_id": model_id,
                "audio_bytes": len(audio_bytes),
                "characters": len(timings["characters"]),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return mp3_path, timings_path, meta_path


def main() -> int:
    p = argparse.ArgumentParser(description="ElevenLabs синтез сегментов")
    p.add_argument("--dir", required=True, help="директория /tmp/voiceover/KS-NNNN/")
    p.add_argument("--segment", type=int, default=None,
                   help="индекс одного сегмента (по умолчанию — все)")
    p.add_argument("--voice-id", default=os.environ.get("ELEVENLABS_VOICE_ID", DEFAULT_VOICE_ID))
    p.add_argument("--model", default=os.environ.get("ELEVENLABS_MODEL", DEFAULT_MODEL_ID))
    p.add_argument("--stability", type=float, default=DEFAULT_STABILITY)
    p.add_argument("--similarity", type=float, default=DEFAULT_SIMILARITY)
    p.add_argument("--style", type=float, default=DEFAULT_STYLE)
    p.add_argument("--no-speaker-boost", action="store_true")
    p.add_argument("--force", action="store_true", help="пересинтез даже при совпадении хеша")
    p.add_argument("--timeout", type=int, default=120)
    args = p.parse_args()

    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        die("env ELEVENLABS_API_KEY не задан")

    dir_path = Path(args.dir).expanduser().resolve()
    if not dir_path.is_dir():
        die(f"директория не найдена: {dir_path}")

    segments = find_segments(dir_path, args.segment)
    if not segments:
        die(f"не найдено segment-*.txt в {dir_path}")

    info(f"найдено сегментов: {len(segments)}; voice_id={args.voice_id} model={args.model}")

    synthesized = 0
    skipped = 0
    failed = 0
    for seg_txt in segments:
        try:
            do_synth, digest = need_resynth(seg_txt, args.voice_id, args.model, args.force)
            if not do_synth:
                info(f"skip {seg_txt.name} (hash совпадает)")
                skipped += 1
                continue
            text = seg_txt.read_text(encoding="utf-8").strip()
            if not text:
                info(f"skip {seg_txt.name} (пустой)")
                skipped += 1
                continue
            info(f"synth {seg_txt.name} ({len(text)} chars)")
            resp = call_elevenlabs(
                text=text,
                api_key=api_key,
                voice_id=args.voice_id,
                model_id=args.model,
                stability=args.stability,
                similarity=args.similarity,
                style=args.style,
                use_speaker_boost=not args.no_speaker_boost,
                timeout_s=args.timeout,
            )
            mp3_path, timings_path, _ = write_outputs(
                seg_txt, resp, digest, args.voice_id, args.model
            )
            info(f"  → {mp3_path.name} ({mp3_path.stat().st_size} B), "
                 f"{timings_path.name} ({len(resp.get('alignment', {}).get('characters', []))} chars)")
            synthesized += 1
        except Exception as e:
            print(f"[synth-eleven] FAIL {seg_txt.name}: {e}", file=sys.stderr)
            failed += 1

    info(f"итог: синтез={synthesized}, skip={skipped}, fail={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
