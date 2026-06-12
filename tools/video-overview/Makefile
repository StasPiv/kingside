# Конвейер видеообзоров (pipeline v2)
#
# Использование:
#   make video KEY=KS-4062                  # полный конвейер
#   make synth KEY=KS-4062                  # только синтез ElevenLabs
#   make synth KEY=KS-4062 SEGMENT=8        # один сегмент
#   make measure KEY=KS-4062                # только замер длительностей
#   make video KEY=KS-4062 VOICE=21m00...   # с явным voice_id
#
# Переменные окружения:
#   ELEVENLABS_API_KEY     — обязателен для synth
#   ELEVENLABS_VOICE_ID    — переопределяет VOICE
#   ELEVENLABS_MODEL       — переопределяет MODEL
#
# Каталоги:
#   /tmp/voiceover/$(KEY)/   — segment-NNN.txt (вход), segment-NNN.mp3 + timings.json (выход)
#   /tmp/$(KEY)/             — segments.json, scene-actions.json, видео, voice.wav

SHELL := /bin/bash
PY    := python3

KEY     ?=
SEGMENT ?=
VOICE   ?=
MODEL   ?= eleven_multilingual_v2
FORCE   ?=

VOICE_DIR   = /tmp/voiceover/$(KEY)
WORK_DIR    = /tmp/$(KEY)
SEGMENTS    = $(WORK_DIR)/segments.json
SCENE_JSON  = $(WORK_DIR)/scene-actions.json
PLACEMENTS  = $(WORK_DIR)/placements.json
VOICE_WAV   = $(WORK_DIR)/voice.wav

TOOLS_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

SYNTH_OPTS = --dir $(VOICE_DIR)
ifneq ($(SEGMENT),)
SYNTH_OPTS += --segment $(SEGMENT)
endif
ifneq ($(VOICE),)
SYNTH_OPTS += --voice-id $(VOICE)
endif
ifneq ($(MODEL),)
SYNTH_OPTS += --model $(MODEL)
endif
ifneq ($(FORCE),)
SYNTH_OPTS += --force
endif

MEASURE_OPTS = --dir $(VOICE_DIR) --out $(SEGMENTS)
ifneq ($(wildcard $(SCENE_JSON)),)
MEASURE_OPTS += --scene-actions $(SCENE_JSON)
endif

.PHONY: video synth measure record build-track ffmpeg check-key check-key-dir clean help

help:
	@echo "Цели: video | synth | measure | record | build-track | ffmpeg"
	@echo "Запуск: make video KEY=KS-4062"

check-key:
	@if [ -z "$(KEY)" ]; then echo "ERROR: KEY=KS-NNNN обязателен"; exit 2; fi

check-key-dir: check-key
	@if [ ! -d "$(VOICE_DIR)" ]; then echo "ERROR: $(VOICE_DIR) не существует"; exit 2; fi
	@mkdir -p $(WORK_DIR)

synth: check-key-dir
	@if [ -z "$$ELEVENLABS_API_KEY" ]; then echo "ERROR: env ELEVENLABS_API_KEY не задан"; exit 3; fi
	$(PY) $(TOOLS_DIR)synth-eleven.py $(SYNTH_OPTS)

measure: check-key-dir
	$(PY) $(TOOLS_DIR)measure-segments.py $(MEASURE_OPTS)

# Запись видео — реализация в задаче QA (tools/video-overview/record.mjs).
# Здесь — заглушка с понятной диагностикой, пока скрипт не лежит в репозитории.
record: check-key-dir
	@if [ ! -f $(TOOLS_DIR)record.mjs ]; then \
		echo "WARN: $(TOOLS_DIR)record.mjs ещё не реализован (QA-задача)"; \
		echo "       пропуск шага записи видео"; \
		exit 0; \
	fi
	cd $(WORK_DIR) && node $(TOOLS_DIR)record.mjs --key=$(KEY)

# Сборка дорожки и финальный mux — реализация в задаче QA.
build-track: check-key-dir
	@if [ ! -f $(TOOLS_DIR)build-track.py ]; then \
		echo "WARN: $(TOOLS_DIR)build-track.py ещё не реализован (QA-задача)"; \
		exit 0; \
	fi
	$(PY) $(TOOLS_DIR)build-track.py $(SEGMENTS) $(PLACEMENTS) $(VOICE_WAV)

ffmpeg: check-key-dir
	@echo "ffmpeg-сборка — пока не автоматизирована в Makefile; реализуется в QA-задаче"

video: synth measure record build-track ffmpeg
	@echo "video pipeline complete for $(KEY)"

clean: check-key
	rm -f $(VOICE_DIR)/segment-*.mp3 \
	      $(VOICE_DIR)/segment-*.timings.json \
	      $(VOICE_DIR)/segment-*.meta.json \
	      $(SEGMENTS)
