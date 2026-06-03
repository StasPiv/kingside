# maia-puzzle-annotation

Admin-CLI для разовой Maia-3 разметки существующих Precision-пазлов.
KS-3632 / ADR-104 §4.

## Что делает

Для каждого `puzzle WHERE solution_mode = 'play-vs-engine'` вычисляет
вероятность правильного хода по Maia-3 и пишет:

- `maia_top1_prob` (Float, 0..1) — вероятность,
- `maia_top1_elo` (Int) — ELO, под которым прогоняли (для
  воспроизводимости и проверки актуальности при смене ENV).

Источник pure-логики: `@kingside/maia-core` (то же ядро, что
переиспользует и `apps/tactic-worker` для continuous-аннотации новых
пазлов, KS-3633).

## Запуск

```bash
# Из корня репо (нужны DATABASE_URL и доступ к ONNX-модели):
node --import tsx tools/maia-puzzle-annotation/src/index.ts \
  --elo 1500 \
  --batch-size 1000 \
  --resume

# Перепрогнать всё под новым ELO:
node --import tsx tools/maia-puzzle-annotation/src/index.ts \
  --elo 1800 --force

# Отчёт по гистограмме и % отсева для порогов 0.3/0.5/0.7:
node --import tsx tools/maia-puzzle-annotation/src/index.ts \
  --report
```

## Флаги

| Флаг | Default | Назначение |
|---|---|---|
| `--elo N` | ENV `PRECISION_MAIA_ANNOTATION_ELO` или 1500 | ELO разметки |
| `--batch-size N` | 1000 | Размер пакета чтения из БД |
| `--resume` | on | Пропускать уже размеченные под текущим ELO |
| `--no-resume` | — | Не пропускать (но non-NULL под другим ELO остаются) |
| `--force` | off | Перезаписать всё (для смены ELO глобально) |
| `--solution-mode M` | `play-vs-engine` | Фильтр |
| `--model-path P` | `apps/web/public/maia3/maia3_simplified.onnx` | Путь к ONNX |
| `--report` | — | Не размечать; вывести гистограмму уже размеченных |
| `--dry-run` | — | Не писать в БД (только лог) |

## Идемпотентность

- `--resume` → повторный запуск с тем же `--elo` пропускает уже
  размеченные. Безопасно прерывать.
- `--force` → перезаписывает всё (используется при смене ENV
  `PRECISION_MAIA_ANNOTATION_ELO` глобально, чтобы привести каталог к
  новому ELO).
- При прерывании на середине: cursor по `id ASC`, следующий запуск
  без `--resume`/`--force` подхватит с того же места (если флаг
  `--resume` оставлен по умолчанию, новые строки попадут).

## ENV

- `DATABASE_URL` — Postgres connection string (main `puzzles`).
- `PRECISION_MAIA_ANNOTATION_ELO` — default ELO для `--elo` (1500).
- `PRECISION_MAIA_MODEL_PATH` — default путь к ONNX-модели.

## Производительность

- Maia-3 inference в Node через `onnxruntime-web` (WASM, 1 thread):
  ~50-200 мс на позицию (зависит от железа).
- Precision-каталог (по grep precision.service.ts comments) — единицы
  тысяч пазлов: ожидаемое время прогона десятки минут.
- Полная разметка 6M lichess-пазлов нерациональна — берём только
  `solution_mode='play-vs-engine'` (см. ADR-104 §4.5).

## Отчёт

После прогона запустить `--report` и положить вывод в комментарий
KS-3630 (распределение `maia_top1_prob` + % отсева для порогов
0.3 / 0.5 / 0.7 — для калибровки `PRECISION_MAIA_DEFAULT_THRESHOLD`).
