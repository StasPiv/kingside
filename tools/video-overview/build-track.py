#!/usr/bin/env python3
"""
build-track.py — сборка голосовой дорожки и финального микса.

Pipeline v2 (ADR-123, шаги 7 и 8):
  - voice.wav  — голосовая дорожка по placements (mp3-сегменты + тишина в стыках).
  - <slug>.webm — финальный микс: видео сцен (single = pad из A1, split = hstack A2|B2)
                  + voice.wav, кодек VP8 + Opus.

Вход:
    /tmp/KS-NNNN/segments.json     — выход measure-segments.py
    /tmp/KS-NNNN/placements.json   — выход record.mjs (с layout, videos, videoOffsets)
    /tmp/voiceover/KS-NNNN/segment-NNN.mp3 — mp3 сегментов

Выход:
    /tmp/KS-NNNN/voice.wav
    /tmp/KS-NNNN/<slug>.webm  (по умолчанию <KEY>-overview.webm)

Опции:
    --key=KS-NNNN
    --slug=<имя>       — имя итогового файла без расширения (по умолчанию <KEY>-overview)
    --voice-only       — собрать только voice.wav
    --no-mix           — не делать финальный микс
    --target-width=W   — итоговая ширина (default 3840)
    --target-height=H  — итоговая высота (default 1200)

Зависимости: ffmpeg, ffprobe (системно).
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def die(msg: str, code: int = 1) -> None:
    print(f"[build-track] ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def info(msg: str) -> None:
    print(f"[build-track] {msg}", file=sys.stderr)


def run(cmd, check=True, capture=False):
    """Запустить ffmpeg/ffprobe и вернуть результат."""
    info("$ " + " ".join(shlex.quote(str(c)) for c in cmd))
    if capture:
        return subprocess.run(cmd, check=check, capture_output=True, text=True)
    return subprocess.run(cmd, check=check)


# ── voice.wav ──────────────────────────────────────────────────────


def build_voice_track(segments: list[dict], placements: list[dict],
                      total_ms: int, voice_wav: Path) -> None:
    """
    Склеить mp3-сегменты в voice.wav по placements (startMs).
    Между сегментами и после последнего — тишина.
    """
    seg_by_idx = {s["idx"]: s for s in segments}
    seg_by_tag = {s.get("tag"): s for s in segments if s.get("tag")}

    # сортируем placements по startMs
    pls = sorted(placements, key=lambda p: p["startMs"])

    # ffmpeg filter_complex: каждый mp3 → adelay → amix
    # для надёжности используем простой генератор: silence + concat
    # формат: 16-bit 48kHz mono
    sr = 48000

    with tempfile.TemporaryDirectory(prefix="ks-voice-") as td_str:
        td = Path(td_str)
        wav_chunks = []  # tuples (start_ms, wav_path, dur_ms)

        for p in pls:
            seg = seg_by_tag.get(p["tag"]) or seg_by_idx.get(p.get("segment"))
            if not seg:
                info(f"WARN: placement {p['tag']} нет в segments.json — skip")
                continue
            mp3 = Path(seg["file"])
            if not mp3.exists():
                info(f"WARN: {mp3} не найден — skip")
                continue
            # декодируем в wav
            wav_path = td / f"{p['tag']}.wav"
            run([
                "ffmpeg", "-y", "-v", "error",
                "-i", str(mp3),
                "-ar", str(sr), "-ac", "1",
                "-c:a", "pcm_s16le",
                str(wav_path),
            ])
            wav_chunks.append((p["startMs"], wav_path, seg["durMs"]))

        # собираем filter_complex: input wav'ы + silence до total_ms,
        # каждый wav adelay'ится в свою startMs позицию, потом amix.
        # Проще: rendered timeline через "concat" с silence-padding.
        # Делаем так: ffmpeg -filter_complex с amerge + adelay.
        if not wav_chunks:
            # пустая дорожка — генерим тишину total_ms
            run([
                "ffmpeg", "-y", "-v", "error",
                "-f", "lavfi",
                "-i", f"anullsrc=channel_layout=mono:sample_rate={sr}",
                "-t", f"{total_ms / 1000.0:.3f}",
                str(voice_wav),
            ])
            return

        inputs = []
        for _, wav_path, _ in wav_chunks:
            inputs.extend(["-i", str(wav_path)])

        filters = []
        amix_inputs = []
        for i, (start_ms, _, _) in enumerate(wav_chunks):
            filters.append(f"[{i}:a]adelay={start_ms}|{start_ms},apad[a{i}]")
            amix_inputs.append(f"[a{i}]")
        n = len(wav_chunks)
        # amix всех дорожек. normalize=0 — суммируем без деления на n
        # (сегменты не пересекаются по времени, клиппинг не возникает).
        # loudnorm доводит до целевого уровня речи −16 LUFS.
        filters.append(
            "".join(amix_inputs)
            + f"amix=inputs={n}:duration=longest:dropout_transition=0:normalize=0,"
              f"atrim=0:{total_ms / 1000.0:.3f},asetpts=N/SR/TB,"
              f"loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
        )
        filter_complex = ";".join(filters)
        cmd = [
            "ffmpeg", "-y", "-v", "error",
            *inputs,
            "-filter_complex", filter_complex,
            "-map", "[aout]",
            "-c:a", "pcm_s16le",
            "-ar", str(sr), "-ac", "1",
            str(voice_wav),
        ]
        run(cmd)


# ── видео-микс ─────────────────────────────────────────────────────


def cut_scene_video(src: Path, offset_ms: int, start_ms: int,
                    hold_ms: int, out: Path, scale_w: int, scale_h: int) -> None:
    """Вырезать кусок видео и привести к scale_w x scale_h (pad если уже,
    crop если шире после scale)."""
    seek_s = (offset_ms + start_ms) / 1000.0
    dur_s = hold_ms / 1000.0
    vf = (
        f"scale={scale_w}:{scale_h}:force_original_aspect_ratio=decrease,"
        f"pad={scale_w}:{scale_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
    )
    run([
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{seek_s:.3f}",
        "-t", f"{dur_s:.3f}",
        "-i", str(src),
        "-vf", vf,
        "-an",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        str(out),
    ])


def hstack_split_scene(src_a: Path, off_a: int, src_b: Path, off_b: int,
                       start_ms: int, hold_ms: int, out: Path,
                       target_w: int, target_h: int) -> None:
    """Двухэкранная сцена: scale обоих до target_w/2 × target_h, hstack."""
    seek_a = (off_a + start_ms) / 1000.0
    seek_b = (off_b + start_ms) / 1000.0
    dur_s = hold_ms / 1000.0
    half_w = target_w // 2
    filter_complex = (
        f"[0:v]scale={half_w}:{target_h}:force_original_aspect_ratio=decrease,"
        f"pad={half_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[la];"
        f"[1:v]scale={half_w}:{target_h}:force_original_aspect_ratio=decrease,"
        f"pad={half_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[lb];"
        f"[la][lb]hstack=inputs=2,setsar=1[out]"
    )
    run([
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{seek_a:.3f}", "-t", f"{dur_s:.3f}", "-i", str(src_a),
        "-ss", f"{seek_b:.3f}", "-t", f"{dur_s:.3f}", "-i", str(src_b),
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-an",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        str(out),
    ])


def concat_scenes(scene_files: list[Path], out_mp4: Path) -> None:
    """Concat-протокол через демультиплексор."""
    with tempfile.NamedTemporaryFile(
        "w", suffix=".txt", delete=False, dir=out_mp4.parent
    ) as f:
        list_path = Path(f.name)
        for s in scene_files:
            f.write(f"file '{s.resolve()}'\n")
    try:
        run([
            "ffmpeg", "-y", "-v", "error",
            "-f", "concat", "-safe", "0",
            "-i", str(list_path),
            "-c", "copy",
            str(out_mp4),
        ])
    finally:
        try:
            list_path.unlink()
        except Exception:
            pass


def mux_final(video_mp4: Path, voice_wav: Path, out_webm: Path) -> None:
    """Финальный mux: видео + voice.wav → webm (VP8 + Opus)."""
    run([
        "ffmpeg", "-y", "-v", "warning",
        "-i", str(video_mp4),
        "-i", str(voice_wav),
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libvpx", "-b:v", "2000k", "-cpu-used", "4", "-deadline", "good",
        "-c:a", "libopus", "-b:a", "128k",
        "-shortest",
        str(out_webm),
    ])


# ── main ───────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description="Build voice track + final mix")
    p.add_argument("--key", required=True, help="KS-NNNN")
    p.add_argument("--slug", default=None,
                   help="имя итогового webm без расширения (по умолчанию <KEY>-overview)")
    p.add_argument("--voice-only", action="store_true")
    p.add_argument("--no-mix", action="store_true")
    p.add_argument("--target-width", type=int, default=3840)
    p.add_argument("--target-height", type=int, default=1200)
    args = p.parse_args()

    key = args.key
    work = Path(f"/tmp/{key}")
    if not work.is_dir():
        die(f"не найден {work}")

    segments_path = work / "segments.json"
    placements_path = work / "placements.json"
    if not segments_path.exists():
        die(f"нет {segments_path} (запусти measure-segments.py / make measure)")
    segments = json.loads(segments_path.read_text(encoding="utf-8"))

    if not args.voice_only and not placements_path.exists():
        die(f"нет {placements_path} (запусти record.mjs / make record)")
    placements_meta = {}
    placements = []
    if placements_path.exists():
        placements_meta = json.loads(placements_path.read_text(encoding="utf-8"))
        placements = placements_meta.get("scenes", placements_meta) if isinstance(
            placements_meta, dict
        ) else placements_meta

    total_ms = (
        placements_meta.get("totalMs")
        if isinstance(placements_meta, dict)
        else None
    )
    if not total_ms:
        # из последней сцены
        if placements:
            last = placements[-1]
            total_ms = last["startMs"] + last["holdMs"]
        else:
            total_ms = sum(s["durMs"] for s in segments) + 400 * len(segments)
    info(f"total_ms={total_ms}")

    voice_wav = work / "voice.wav"
    info(f"building voice track → {voice_wav}")
    build_voice_track(segments, placements, total_ms, voice_wav)
    info(f"voice.wav готов ({voice_wav.stat().st_size} B)")

    if args.voice_only:
        info("voice-only: финальный микс пропущен")
        return 0

    if args.no_mix:
        info("--no-mix: финальный микс пропущен")
        return 0

    # видео-микс
    videos = placements_meta.get("videos", {}) if isinstance(placements_meta, dict) else {}
    offsets = placements_meta.get("videoOffsets", {}) if isinstance(placements_meta, dict) else {}
    src_a1 = Path(videos.get("A1", "")) if videos.get("A1") else None
    src_a2 = Path(videos.get("A2", "")) if videos.get("A2") else None
    src_b2 = Path(videos.get("B2", "")) if videos.get("B2") else None

    target_w = args.target_width
    target_h = args.target_height

    scenes_dir = work / "scenes-tmp"
    scenes_dir.mkdir(exist_ok=True)
    # clean previous
    for f in scenes_dir.glob("scene-*.mp4"):
        f.unlink()

    scene_files: list[Path] = []
    for i, pl in enumerate(placements):
        out = scenes_dir / f"scene-{i:02d}-{pl['tag']}.mp4"
        layout = pl.get("layout", "single")
        try:
            if layout == "split":
                if not (src_a2 and src_a2.exists() and src_b2 and src_b2.exists()):
                    die("split scene, но нет видео A2/B2")
                hstack_split_scene(
                    src_a2, offsets.get("A2", 0),
                    src_b2, offsets.get("B2", 0),
                    pl["startMs"], pl["holdMs"], out,
                    target_w, target_h,
                )
            else:
                if not (src_a1 and src_a1.exists()):
                    die("single scene, но нет видео A1")
                cut_scene_video(
                    src_a1, offsets.get("A1", 0),
                    pl["startMs"], pl["holdMs"], out,
                    target_w, target_h,
                )
        except subprocess.CalledProcessError as e:
            die(f"ffmpeg failed на сцене {pl['tag']}: {e}")
        scene_files.append(out)
        info(f"  scene {i} {pl['tag']} ({layout}) → {out.name}")

    video_mp4 = work / "video-noaudio.mp4"
    concat_scenes(scene_files, video_mp4)

    slug = args.slug or f"{key}-overview"
    final = work / f"{slug}.webm"
    mux_final(video_mp4, voice_wav, final)
    info(f"final → {final} ({final.stat().st_size} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
