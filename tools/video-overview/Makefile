# Конвейер видеообзоров (pipeline v3 — посегментная запись + точечная пересъёмка)
#
# Спецификация: docs/content-guide/video-overview-pipeline.md
#
# Использование:
#   make video KEY=KS-4062                       # полный конвейер (идемпотентно)
#   make rescene KEY=KS-4316 SCENE=<sceneId>     # переснять цепочку этой сцены + финал
#   make scene KEY=KS-4316 SCENE=<sceneId>       # переснять одну сцену (без финального микса)
#   make plan-only KEY=KS-4062                   # показать план пересъёмки и выйти
#   make scenes-clean KEY=KS-4062                # снести кеш сцен/цепочек/состояний
#   make synth KEY=KS-4062 [SEGMENT=8]           # синтез ElevenLabs
#   make measure KEY=KS-4062                     # замер длительностей mp3
#   make video KEY=KS-4062 VOICE=21m00...        # с явным voice_id
#
# Переменные окружения:
#   ELEVENLABS_API_KEY     — обязателен для synth
#   ELEVENLABS_VOICE_ID    — переопределяет VOICE
#   ELEVENLABS_MODEL       — переопределяет MODEL
#   KS_RECORD_USER         — фиксированный dev-bypass пользователь (для seed-driven сценариев)
#
# Каталоги:
#   /tmp/voiceover/$(KEY)/   — segment-NNN.txt (вход), segment-NNN.mp3 + timings.json (выход)
#   /tmp/$(KEY)/             — scene-actions.json, segments.json
#   /tmp/$(KEY)/scenes/      — v3: per-scene capture.webm + meta.json (кеш по hash)
#   /tmp/$(KEY)/chains/      — v3: master-*.webm цепочек (опциональный кеш)
#   /tmp/$(KEY)/state/       — v3: stateOut цепочек (.out.json)
#   /tmp/$(KEY)/videos/      — v2 legacy: A1/B1/A2/B2 контекстные webm

SHELL := /bin/bash
PY    := python3

KEY     ?=
SEGMENT ?=
VOICE   ?=
MODEL   ?= eleven_multilingual_v2
FORCE   ?=
SLUG    ?=
SCENE   ?=
CHAIN   ?=
KEEP_MASTERS ?=

VOICE_DIR   = /tmp/voiceover/$(KEY)
WORK_DIR    = /tmp/$(KEY)
SEGMENTS    = $(WORK_DIR)/segments.json
SCENE_JSON  = $(WORK_DIR)/scene-actions.json
PLACEMENTS  = $(WORK_DIR)/placements.json
VOICE_WAV   = $(WORK_DIR)/voice.wav
SCENES_DIR  = $(WORK_DIR)/scenes
CHAINS_DIR  = $(WORK_DIR)/chains
STATE_DIR   = $(WORK_DIR)/state

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

RECORD_OPTS = --key=$(KEY)
ifneq ($(SCENE),)
RECORD_OPTS += --scene=$(SCENE)
endif
ifneq ($(CHAIN),)
RECORD_OPTS += --chain=$(CHAIN)
endif
ifneq ($(FORCE),)
RECORD_OPTS += --force
endif
ifneq ($(KEEP_MASTERS),)
RECORD_OPTS += --keep-masters=$(KEEP_MASTERS)
endif

.PHONY: video synth measure record build-track check-key check-key-dir \
        rescene scene scenes-clean plan-only clean help

help:
	@echo "Цели pipeline v3:"
	@echo "  make video KEY=KS-NNNN                  — полный конвейер (идемпотентно)"
	@echo "  make rescene KEY=KS-NNNN SCENE=<id>     — переснять цепочку сцены + финал"
	@echo "  make scene KEY=KS-NNNN SCENE=<id>       — алиас rescene"
	@echo "  make plan-only KEY=KS-NNNN              — показать план без запуска"
	@echo "  make scenes-clean KEY=KS-NNNN           — снести кеш scenes/ chains/ state/"
	@echo "  make synth | measure | record | build-track — этапы по отдельности"

check-key:
	@if [ -z "$(KEY)" ]; then echo "ERROR: KEY=KS-NNNN обязателен"; exit 2; fi

check-key-dir: check-key
	@if [ ! -d "$(VOICE_DIR)" ]; then echo "ERROR: $(VOICE_DIR) не существует"; exit 2; fi
	@mkdir -p $(WORK_DIR) $(SCENES_DIR) $(CHAINS_DIR) $(STATE_DIR)

synth: check-key-dir
	@if [ -z "$$ELEVENLABS_API_KEY" ]; then echo "ERROR: env ELEVENLABS_API_KEY не задан"; exit 3; fi
	$(PY) $(TOOLS_DIR)synth-eleven.py $(SYNTH_OPTS)

measure: check-key-dir
	$(PY) $(TOOLS_DIR)measure-segments.py $(MEASURE_OPTS)

# Запись видео — Playwright по scene-actions.json. v3-формат → ветка plan-rebuild +
# цикл по DIRTY цепочкам. v2-формат — старая запись одним прогоном.
record: check-key-dir
	cd $(WORK_DIR) && node $(TOOLS_DIR)record.mjs $(RECORD_OPTS)

# Сборка voice.wav + финальный микс. v3: concat scenes/<id>/capture.webm + voice.
# v2 legacy: cut из A1/B1/A2/B2 webm по placements.json.
BUILD_TRACK_OPTS = --key $(KEY)
ifneq ($(SLUG),)
BUILD_TRACK_OPTS += --slug $(SLUG)
endif

build-track: check-key-dir
	$(PY) $(TOOLS_DIR)build-track.py $(BUILD_TRACK_OPTS)

video: synth measure record build-track
	@echo "video pipeline complete for $(KEY)"

# Точечная пересъёмка одной сцены. Удаляет meta.json её цепочки → record признаёт
# цепочку DIRTY → одна Playwright-сессия → нарезка → финал пересобирается.
rescene: check-key-dir
	@if [ -z "$(SCENE)" ]; then echo "ERROR: SCENE=<sceneId> обязателен"; exit 2; fi
	@$(PY) $(TOOLS_DIR)record.mjs --invalidate --key=$(KEY) --scene=$(SCENE) 2>/dev/null \
	    || node $(TOOLS_DIR)record.mjs --invalidate --key=$(KEY) --scene=$(SCENE)
	$(MAKE) -f $(TOOLS_DIR)Makefile record KEY=$(KEY)
	$(MAKE) -f $(TOOLS_DIR)Makefile build-track KEY=$(KEY) SLUG=$(SLUG)

# Алиас rescene: переснять одну сцену + переcобрать финал.
scene: rescene

# Показать план пересъёмки без запуска Playwright.
plan-only: check-key-dir
	cd $(WORK_DIR) && node $(TOOLS_DIR)record.mjs --key=$(KEY) --plan-only

# Чистка кеша v3. Озвучка не трогается.
scenes-clean: check-key
	rm -rf $(SCENES_DIR) $(CHAINS_DIR) $(STATE_DIR)
	@echo "cleaned scenes/ chains/ state/ in $(WORK_DIR)"

clean: check-key
	rm -f $(VOICE_DIR)/segment-*.mp3 \
	      $(VOICE_DIR)/segment-*.timings.json \
	      $(VOICE_DIR)/segment-*.meta.json \
	      $(SEGMENTS)
