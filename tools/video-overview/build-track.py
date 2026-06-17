#!/usr/bin/env python3
"""
build-track.py — сборка голосовой дорожки и финального микса.

Pipeline v3 (docs/content-guide/video-overview-pipeline.md):
  Главный режим — `--key=KS-NNNN`. Конвейер сам выбирает ветку:
    1. v3 (scene-actions.v3 + scenes/<id>/capture.webm на месте)
       → concat capture.webm в порядке декларации chains[].scenes[]
         + voice.wav (по timing сегментов) + mux.
    2. v2 legacy (placements.json + videos/A1..B2/<uuid>.webm)
       → cut по placements + hstack split + voice + mux. (ADR-123)

Также есть служебный режим `--cut-capture` — нарезка одной capture.webm
из master-видео цепочки. Используется record.mjs (v3) после записи
каждой цепочки. Логика и flags идентичны v2 cut_scene_video, поэтому
выделены в общий хелпер.

Вход (v3):
    /tmp/KS-NNNN/scene-actions.json    — $schema=scene-actions.v3
    /tmp/KS-NNNN/segments.json         — выход measure-segments.py
    /tmp/KS-NNNN/scenes/<id>/capture.webm  — выход record.mjs (v3 runner)
    /tmp/KS-NNNN/scenes/<id>/meta.json     — холдинговая длительность и т.п.
    /tmp/voiceover/KS-NNNN/segment-NNN.mp3 — mp3 сегментов

Вход (v2 legacy):
    /tmp/KS-NNNN/segments.json
    /tmp/KS-NNNN/placements.json
    /tmp/voiceover/KS-NNNN/segment-NNN.mp3

Выход:
    /tmp/KS-NNNN/voice.wav
    /tmp/KS-NNNN/<slug>.webm  (по умолчанию <KEY>-overview.webm)

Опции:
    --key=KS-NNNN
    --slug=<имя>       — имя итогового файла без расширения (по умолчанию <KEY>-overview)
    --voice-only       — собрать только voice.wav
    --no-mix           — не делать финальный микс
    --target-width=W   — итоговая ширина (default 1920)
    --target-height=H  — итоговая высота (default 1200)
    --cut-capture --src <webm> --start-ms N --hold-ms N --out <capture.webm>
                       [--offset-ms N] [--splice-head N --splice-tail N]
                       [--target-width W] [--target-height H]
                       [--src-b <webm> --offset-ms-b N --split]
                                          — служебный режим: нарезка одной сцены.

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

    # Финальное видео получается concat'ом вырезанных кусков длительностью holdMs
    # подряд без пауз — таймлайн финала смещён относительно placements.startMs
    # (где между сценами лежит время metaActions + switching контекстов).
    # Голос должен ставиться по финальному таймлайну = сумме предыдущих holdMs,
    # иначе он отстаёт от видео на сумму этих промежутков.
    final_start_by_tag = {}
    cum = 0
    for p in pls:
        final_start_by_tag[p["tag"]] = cum
        sp = p.get("splice")
        # KS-4066: склейка сцены — эффективная длина = голова + хвост.
        eff = (sp["headMs"] + sp["tailMs"]) if sp else p.get("holdMs", p.get("durMs", 0))
        cum += eff

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
            # для adelay используем финальный таймлайн (накопленные holdMs),
            # а не placements.startMs — иначе голос отстаёт от видео на сумму
            # времени metaActions и переключений контекстов между сценами.
            final_start = final_start_by_tag.get(p["tag"], p["startMs"])
            wav_chunks.append((final_start, wav_path, seg["durMs"]))

        # собираем filter_complex: input wav'ы + silence до total_ms,
        # каждый wav adelay'ится в свою startMs позицию, потом amix.
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


# ── видео-нарезка (cuts) ───────────────────────────────────────────
#
# Фиксированный GOP 12 кадров при 30fps + keyint_min = 12 → нарезанные
# capture-файлы на стыке concat'а дают совпадающие keyframes и не
# дребезжат (см. спецификацию v3 §10.1).
#
# Кодек подбирается по расширению out:
#   .webm → libvpx (VP8) — нужен для v3 scenes/<id>/capture.webm
#   .mp4  → libx264       — нужен для legacy v2 scene-NN.mp4 (быстрее concat)


_X264_OPTS = [
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "20",
    "-g", "12",
    "-keyint_min", "12",
    "-sc_threshold", "0",
    "-pix_fmt", "yuv420p",
]

_VPX_OPTS = [
    "-c:v", "libvpx",
    "-b:v", "2000k",
    "-cpu-used", "4",
    "-deadline", "good",
    "-g", "12",
    "-keyint_min", "12",
    "-auto-alt-ref", "0",
    "-pix_fmt", "yuv420p",
]


def _enc_opts_for(out: Path) -> list[str]:
    return _VPX_OPTS if out.suffix.lower() == ".webm" else _X264_OPTS


def cut_scene_video(src: Path, offset_ms: int, start_ms: int,
                    hold_ms: int, out: Path, scale_w: int, scale_h: int) -> None:
    """Вырезать кусок видео и привести к scale_w x scale_h."""
    seek_s = (offset_ms + start_ms) / 1000.0
    dur_s = hold_ms / 1000.0
    vf = (
        f"scale={scale_w}:{scale_h}:force_original_aspect_ratio=decrease,"
        f"pad={scale_w}:{scale_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    run([
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{seek_s:.3f}",
        "-t", f"{dur_s:.3f}",
        "-i", str(src),
        "-vf", vf,
        "-an",
        *_enc_opts_for(out),
        str(out),
    ])


def cut_scene_spliced(src: Path, offset_ms: int, start_ms: int, hold_ms: int,
                      head_ms: int, tail_ms: int, out: Path,
                      scale_w: int, scale_h: int) -> None:
    """KS-4066: сцена = голова (старт, head_ms) + хвост (конец, tail_ms),
    середина вырезается. Для длинных действий (генерация пазлов): показываем
    старт и финальный результат, не растягивая на всё время прогона."""
    tmp_head = out.parent / (out.stem + "-head.mp4")
    tmp_tail = out.parent / (out.stem + "-tail.mp4")
    out.parent.mkdir(parents=True, exist_ok=True)
    cut_scene_video(src, offset_ms, start_ms, head_ms, tmp_head, scale_w, scale_h)
    cut_scene_video(src, offset_ms, start_ms + hold_ms - tail_ms, tail_ms,
                    tmp_tail, scale_w, scale_h)
    concat_scenes([tmp_head, tmp_tail], out)
    for f in (tmp_head, tmp_tail):
        try:
            f.unlink()
        except OSError:
            pass


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
    out.parent.mkdir(parents=True, exist_ok=True)
    run([
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{seek_a:.3f}", "-t", f"{dur_s:.3f}", "-i", str(src_a),
        "-ss", f"{seek_b:.3f}", "-t", f"{dur_s:.3f}", "-i", str(src_b),
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-an",
        *_enc_opts_for(out),
        str(out),
    ])


def concat_scenes(scene_files: list[Path], out_mp4: Path) -> None:
    """Concat-протокол через демультиплексор. На входе ожидаются файлы,
    кодированные одинаковыми параметрами (GOP, кодек) — у нас это
    гарантировано _X264_OPTS."""
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


def mux_final(video_in: Path, voice_wav: Path, out_webm: Path) -> None:
    """Финальный mux: видео + voice.wav → webm (VP8 + Opus).

    Если вход уже webm/vp8 — копируем поток без перекодирования (typical для v3,
    где video-noaudio.webm собран из capture.webm cuts). Иначе re-encode в vp8."""
    if video_in.suffix.lower() == ".webm":
        v_opts = ["-c:v", "copy"]
    else:
        v_opts = [
            "-c:v", "libvpx", "-b:v", "2000k",
            "-cpu-used", "4", "-deadline", "good",
        ]
    run([
        "ffmpeg", "-y", "-v", "warning",
        "-i", str(video_in),
        "-i", str(voice_wav),
        "-map", "0:v", "-map", "1:a",
        *v_opts,
        "-c:a", "libopus", "-b:a", "128k",
        "-shortest",
        str(out_webm),
    ])


def probe_duration_ms(src: Path) -> int:
    """Длительность медиафайла в миллисекундах через ffprobe."""
    r = run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(src),
    ], capture=True)
    try:
        sec = float(r.stdout.strip())
        return int(round(sec * 1000))
    except Exception:
        return 0


# ── v3: служебный режим --cut-capture (вызывается из record.mjs) ────


def cmd_cut_capture(args) -> int:
    """Нарезка одной сцены из master-видео цепочки.

    Используется record.mjs после записи цепочки. Один capture.webm =
    один scene-id. Применяет layout (single/split), splice (опционально),
    pad/crop. Кодирование с фиксированным GOP для совместимости concat'а
    в финальной сборке.
    """
    src = Path(args.src)
    if not src.is_file():
        die(f"--src не найден: {src}")
    out = Path(args.out)
    target_w = args.target_width
    target_h = args.target_height
    offset = args.offset_ms
    start = args.start_ms
    hold = args.hold_ms

    if args.split:
        if not args.src_b:
            die("--split требует --src-b=<webm>")
        src_b = Path(args.src_b)
        if not src_b.is_file():
            die(f"--src-b не найден: {src_b}")
        offset_b = args.offset_ms_b
        hstack_split_scene(
            src, offset, src_b, offset_b,
            start, hold, out,
            target_w, target_h,
        )
        return 0

    if args.splice_head and args.splice_tail:
        cut_scene_spliced(
            src, offset, start, hold,
            args.splice_head, args.splice_tail, out,
            target_w, target_h,
        )
        return 0

    cut_scene_video(src, offset, start, hold, out, target_w, target_h)
    return 0


# ── v3: финальная сборка через scenes/<id>/capture.webm ────────────


def build_v3(work: Path, segments: list[dict], scenes_raw: dict,
             voice_wav: Path, target_w: int, target_h: int,
             slug: str, voice_only: bool, no_mix: bool) -> int:
    """Концат scenes/<id>/capture.webm в порядке chains[].scenes[]."""
    scenes_dir = work / "scenes"

    # flat order по chains[].scenes[]
    scene_records = []  # [{sceneId, segment, durMs, holdMs, splice?, captureWebm}]
    seg_by_idx = {s["idx"]: s for s in segments}
    seg_by_tag = {s.get("tag"): s for s in segments if s.get("tag")}

    for ch in scenes_raw.get("chains", []):
        for sc in ch.get("scenes", []):
            sid = sc.get("sceneId")
            seg_idx = sc.get("segment")
            if not sid or seg_idx is None:
                die(f"scene без sceneId/segment в chain {ch.get('chainId')}")
            seg = seg_by_idx.get(seg_idx) or seg_by_tag.get(sid)
            if not seg:
                die(f"сегмент {seg_idx} (scene {sid}) нет в segments.json")
            cap_dir = scenes_dir / sid
            cap_webm = cap_dir / "capture.webm"
            meta_path = cap_dir / "meta.json"
            if not cap_webm.is_file():
                die(f"нет {cap_webm} — сначала запиши через record.mjs")
            meta = {}
            try:
                meta = json.loads(meta_path.read_text())
            except FileNotFoundError:
                pass
            hold_ms = meta.get("holdMs") or probe_duration_ms(cap_webm)
            scene_records.append({
                "sceneId": sid,
                "tag": sid,                # для совместимости c build_voice_track
                "segment": seg_idx,
                "durMs": seg["durMs"],
                "holdMs": hold_ms,
                "startMs": 0,              # не используется в v3 timeline
                "splice": meta.get("splice"),
                "captureWebm": cap_webm,
            })

    if not scene_records:
        die("v3 сборка: нет ни одной сцены")

    # voice timeline: сумма holdMs/splice eff.
    total_ms = 0
    for r in scene_records:
        sp = r.get("splice")
        eff = (sp["headMs"] + sp["tailMs"]) if sp else r["holdMs"]
        total_ms += eff

    info(f"v3 build: {len(scene_records)} scenes, total_ms={total_ms}")

    # voice.wav
    info(f"building voice track → {voice_wav}")
    placements = [{
        "tag": r["sceneId"],
        "segment": r["segment"],
        "startMs": r["startMs"],
        "holdMs": r["holdMs"],
        **({"splice": r["splice"]} if r["splice"] else {}),
    } for r in scene_records]
    build_voice_track(segments, placements, total_ms, voice_wav)
    info(f"voice.wav готов ({voice_wav.stat().st_size} B)")

    if voice_only:
        info("voice-only: финальный микс пропущен")
        return 0
    if no_mix:
        info("--no-mix: финальный микс пропущен")
        return 0

    # Концат capture.webm в video-noaudio.webm. capture.webm — vp8/matroska
    # с фиксированным GOP12, поэтому concat demuxer (без перекодирования)
    # работает. Fallback на filter concat — на случай рассинхронизированных
    # параметров (например, если запись цепочки сделана старой версией tools).
    captures = [r["captureWebm"] for r in scene_records]

    video_noaudio = work / "video-noaudio.webm"
    with tempfile.NamedTemporaryFile(
        "w", suffix=".txt", delete=False, dir=str(work)
    ) as f:
        list_path = Path(f.name)
        for c in captures:
            f.write(f"file '{c.resolve()}'\n")
    try:
        try:
            run([
                "ffmpeg", "-y", "-v", "error",
                "-f", "concat", "-safe", "0",
                "-i", str(list_path),
                "-c", "copy",
                str(video_noaudio),
            ])
        except subprocess.CalledProcessError:
            info("concat demuxer не сошёлся — fallback на filter concat (перекодирование)")
            inputs = []
            for c in captures:
                inputs.extend(["-i", str(c)])
            n = len(captures)
            fc = "".join(f"[{i}:v]setsar=1[v{i}];" for i in range(n))
            fc += "".join(f"[v{i}]" for i in range(n))
            fc += f"concat=n={n}:v=1:a=0[outv]"
            run([
                "ffmpeg", "-y", "-v", "error",
                *inputs,
                "-filter_complex", fc,
                "-map", "[outv]",
                "-an",
                *_VPX_OPTS,
                str(video_noaudio),
            ])
    finally:
        try:
            list_path.unlink()
        except Exception:
            pass

    final = work / f"{slug}.webm"
    mux_final(video_noaudio, voice_wav, final)
    info(f"final → {final} ({final.stat().st_size} B)")
    return 0


# ── v2 legacy: full pipeline через placements + 4 webm ──────────────


def build_v2_legacy(work: Path, segments: list[dict], voice_wav: Path,
                    target_w: int, target_h: int, slug: str,
                    voice_only: bool, no_mix: bool) -> int:
    placements_path = work / "placements.json"
    if not voice_only and not placements_path.exists():
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
        if placements:
            last = placements[-1]
            total_ms = last["startMs"] + last["holdMs"]
        else:
            total_ms = sum(s["durMs"] for s in segments) + 400 * len(segments)
    info(f"total_ms={total_ms}")

    info(f"building voice track → {voice_wav}")
    build_voice_track(segments, placements, total_ms, voice_wav)
    info(f"voice.wav готов ({voice_wav.stat().st_size} B)")

    if voice_only:
        info("voice-only: финальный микс пропущен")
        return 0
    if no_mix:
        info("--no-mix: финальный микс пропущен")
        return 0

    videos = placements_meta.get("videos", {}) if isinstance(placements_meta, dict) else {}
    offsets = placements_meta.get("videoOffsets", {}) if isinstance(placements_meta, dict) else {}
    src_a1 = Path(videos.get("A1", "")) if videos.get("A1") else None
    src_b1 = Path(videos.get("B1", "")) if videos.get("B1") else None
    src_a2 = Path(videos.get("A2", "")) if videos.get("A2") else None
    src_b2 = Path(videos.get("B2", "")) if videos.get("B2") else None

    scenes_dir = work / "scenes-tmp"
    scenes_dir.mkdir(exist_ok=True)
    for f in scenes_dir.glob("scene-*.mp4"):
        f.unlink()

    scene_files: list[Path] = []
    for i, pl in enumerate(placements):
        out = scenes_dir / f"scene-{i:02d}-{pl['tag']}.mp4"
        layout = pl.get("layout", "single")
        try:
            if layout == "split":
                split_source = pl.get("splitSource", "A2+B2")
                if split_source == "A1+B2":
                    if not (src_a1 and src_a1.exists() and src_b2 and src_b2.exists()):
                        die("split A1+B2 scene, но нет видео A1/B2")
                    hstack_split_scene(
                        src_a1, offsets.get("A1", 0),
                        src_b2, offsets.get("B2", 0),
                        pl["startMs"], pl["holdMs"], out,
                        target_w, target_h,
                    )
                else:
                    if not (src_a2 and src_a2.exists() and src_b2 and src_b2.exists()):
                        die("split scene, но нет видео A2/B2")
                    hstack_split_scene(
                        src_a2, offsets.get("A2", 0),
                        src_b2, offsets.get("B2", 0),
                        pl["startMs"], pl["holdMs"], out,
                        target_w, target_h,
                    )
            elif layout == "single-viewer":
                if not (src_b1 and src_b1.exists()):
                    die("single-viewer scene, но нет видео B1 "
                        "(включи wideViewportB=true в scene-actions.json)")
                sp = pl.get("splice")
                if sp:
                    cut_scene_spliced(
                        src_b1, offsets.get("B1", 0),
                        pl["startMs"], pl["holdMs"],
                        sp["headMs"], sp["tailMs"], out,
                        target_w, target_h,
                    )
                else:
                    cut_scene_video(
                        src_b1, offsets.get("B1", 0),
                        pl["startMs"], pl["holdMs"], out,
                        target_w, target_h,
                    )
            else:
                if not (src_a1 and src_a1.exists()):
                    die("single scene, но нет видео A1")
                sp = pl.get("splice")
                if sp:
                    cut_scene_spliced(
                        src_a1, offsets.get("A1", 0),
                        pl["startMs"], pl["holdMs"],
                        sp["headMs"], sp["tailMs"], out,
                        target_w, target_h,
                    )
                else:
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

    final = work / f"{slug}.webm"
    mux_final(video_mp4, voice_wav, final)
    info(f"final → {final} ({final.stat().st_size} B)")
    return 0


# ── main ───────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description="Build voice track + final mix (pipeline v3)")
    sub = p.add_subparsers(dest="mode")

    # default режим — без подкоманды; флаги напрямую.
    p.add_argument("--key", help="KS-NNNN")
    p.add_argument("--slug", default=None,
                   help="имя итогового webm без расширения (по умолчанию <KEY>-overview)")
    p.add_argument("--voice-only", action="store_true")
    p.add_argument("--no-mix", action="store_true")
    p.add_argument("--target-width", type=int, default=1920)
    p.add_argument("--target-height", type=int, default=1200)

    # cut-capture флаги (служебный режим для record.mjs v3)
    p.add_argument("--cut-capture", action="store_true",
                   help="служебный режим: нарезка одной сцены из master")
    p.add_argument("--src", help="(cut-capture) master webm")
    p.add_argument("--offset-ms", type=int, default=0,
                   help="(cut-capture) смещение Playwright recordVideo до chainStart")
    p.add_argument("--start-ms", type=int, default=0,
                   help="(cut-capture) startMs сцены внутри master")
    p.add_argument("--hold-ms", type=int, default=0,
                   help="(cut-capture) holdMs сцены")
    p.add_argument("--out", help="(cut-capture) путь к capture.webm")
    p.add_argument("--splice-head", type=int, default=None,
                   help="(cut-capture) длительность головы splice")
    p.add_argument("--splice-tail", type=int, default=None,
                   help="(cut-capture) длительность хвоста splice")
    p.add_argument("--split", action="store_true",
                   help="(cut-capture) split-сцена: hstack двух master'ов")
    p.add_argument("--src-b", help="(cut-capture, split) второй master")
    p.add_argument("--offset-ms-b", type=int, default=0,
                   help="(cut-capture, split) offset второго master'а")

    args = p.parse_args()

    if args.cut_capture:
        return cmd_cut_capture(args)

    if not args.key:
        die("--key обязателен (или --cut-capture)")

    key = args.key
    work = Path(f"/tmp/{key}")
    if not work.is_dir():
        die(f"не найден {work}")

    segments_path = work / "segments.json"
    if not segments_path.exists():
        die(f"нет {segments_path} (запусти measure-segments.py / make measure)")
    segments = json.loads(segments_path.read_text(encoding="utf-8"))

    voice_wav = work / "voice.wav"
    target_w = args.target_width
    target_h = args.target_height
    slug = args.slug or f"{key}-overview"

    # Определяем v3 vs v2 legacy по scene-actions.json + наличию capture.webm.
    scene_actions_path = work / "scene-actions.json"
    is_v3 = False
    scenes_raw = None
    if scene_actions_path.exists():
        try:
            scenes_raw = json.loads(scene_actions_path.read_text(encoding="utf-8"))
            if isinstance(scenes_raw, dict) and scenes_raw.get("$schema") == "scene-actions.v3":
                is_v3 = True
        except Exception:
            pass

    if is_v3:
        info(f"using v3 pipeline (scene-actions.v3) for {key}")
        return build_v3(work, segments, scenes_raw, voice_wav, target_w, target_h,
                        slug, args.voice_only, args.no_mix)

    info(f"using v2 legacy pipeline for {key}")
    return build_v2_legacy(work, segments, voice_wav, target_w, target_h,
                           slug, args.voice_only, args.no_mix)


if __name__ == "__main__":
    sys.exit(main())
