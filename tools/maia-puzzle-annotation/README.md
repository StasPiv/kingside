# maia-puzzle-annotation

Admin-CLI разовой Maia-3 + Stockfish разметки Precision-пазлов.
KS-3641 / ADR-106 (заменяет KS-3632 / ADR-104).

## Что делает

Для каждого `puzzle WHERE solution_mode = 'play-vs-engine'` вычисляет
метрику `maiaWeakChoiceProb` по ADR-106 §2.1:

1. Maia inference → распределение `policy[m]` по легальным ходам.
2. `MaiaTopK = { m | policy[m] > 0.10 } ∩ top-8 by policy`.
3. `searchmoves = unique([firstMovePV1, ...MaiaTopK])`.
4. Stockfish `go depth N searchmoves m1 m2 …` → WDL по каждому.
5. `bestE = max(expectedScoreFromWdl(wdl_i))` среди searchmoves.
6. `weak_set = { m ∈ MaiaTopK | bestE − E(m) > 0.02 }`.
7. `maiaWeakChoiceProb = Σ policy[m]` для m ∈ weak_set.

Пишет в `puzzles` три поля:

- `maia_weak_choice_prob` (REAL, 0..1) — суммарная вероятность сыграть
  слабый ход;
- `maia_metric_version` (INT) — версия алгоритма (актуальная константа
  в `@kingside/maia-core/MAIA_WEAK_CHOICE_METRIC_VERSION`);
- `maia_top1_elo` (INT) — ELO разметки (audit-поле под ENV
  `PRECISION_MAIA_ANNOTATION_ELO`).

Pure-вычисление и константы — `@kingside/maia-core/weak-choice`
(переиспользуется с continuous-аннотацией в `apps/tactic-worker`,
KS-3640).

## Запуск

```bash
# Локально (из корня репо). DATABASE_URL обязателен.
node --import tsx tools/maia-puzzle-annotation/src/index.ts \
  --elo=1500 --batch-size=1000 --force

# Прод (внутри tactic-worker контейнера через ECS RunTask):
node --import tsx /app/tools/maia-puzzle-annotation/src/index.ts \
  --elo=1500 --batch-size=1000 --force

# Отчёт по уже размеченным (без --force):
node --import tsx tools/maia-puzzle-annotation/src/index.ts --report

# Дebug без записи в БД (без --force):
node --import tsx tools/maia-puzzle-annotation/src/index.ts \
  --elo=1500 --batch-size=10 --dry-run
```

`--force` ОБЯЗАТЕЛЕН для annotate-прогона. После миграции KS-3639
старые значения `maia_top1_prob` физически переехали в
`maia_weak_choice_prob`, но семантически несовместимы под новой
формулой (ADR-106 §5). Без `--force` CLI прерывается с подсказкой.

## Флаги

| Флаг | Default | Назначение |
|---|---|---|
| `--elo N` | ENV `PRECISION_MAIA_ANNOTATION_ELO` или 1500 | ELO разметки |
| `--batch-size N` | 1000 | Размер пакета чтения из БД |
| `--sf-depth N` | ENV `PRECISION_MAIA_SF_DEPTH` или 15 | Stockfish depth для оценки кандидатов |
| `--resume` | on | Пропускать строки уже размеченные под текущим (`elo`, `metric_version`) |
| `--no-resume` | — | Не пропускать (но non-NULL под другим (elo, version) остаются) |
| `--force` | off | Перезаписать всё, ОБЯЗАТЕЛЕН для annotate |
| `--solution-mode M` | `play-vs-engine` | Фильтр solution_mode |
| `--model-path P` | резолвится от файла CLI (`/app/tools/maia3/maia3_simplified.onnx` в проде) | Путь к ONNX |
| `--report` | — | Не размечать; вывести гистограмму + % `>= порога` |
| `--dry-run` | — | Не писать в БД (только лог + рассчитанные значения) |

Формат `--key=value` и `--key value` оба поддержаны. На неизвестный
флаг или positional CLI завершается с `exit=2` и печатает usage.

## Идемпотентность

- `--resume` → повторный запуск с теми же `(elo, metric_version)`
  пропускает уже размеченные. Безопасно прерывать.
- `--force` → перезаписывает всё, независимо от старых значений.
  Обязательно сразу после миграции KS-3639 (старые `maia_top1_prob`
  под другой формулой).
- Прерывание в середине: cursor по `id ASC`; следующий запуск с
  `--resume` подхватит с того же места.

## ENV

- `DATABASE_URL` — Postgres connection string (main `puzzles`).
- `PRECISION_MAIA_ANNOTATION_ELO` — default для `--elo` (1500).
- `PRECISION_MAIA_SF_DEPTH` — default для `--sf-depth` (15).
- `PRECISION_MAIA_MODEL_PATH` — default для `--model-path`.
- `STOCKFISH_PATH` — путь к бинарю (default `/usr/games/stockfish`,
  установлен в Docker через apt).
- `STOCKFISH_THREADS` — default 1 (детерминированность).

## Производительность

- Maia-3 inference в Node через `onnxruntime-web` (WASM, 1 thread):
  ~50–200 мс на позицию.
- Stockfish с `searchmoves` (N ≤ 9), depth=15: ~0.5–1 с на позицию.
- На один пазл: ~1 с. Разовая досыпка 12k пазлов: ~3.5 ч одной
  машиной; параллельным запуском нескольких CLI с шардингом по
  range id — ~1 ч (см. ADR-106 §3).

## Отчёт

`--report` выводит для всех строк с актуальной `metric_version`:

- общее число обработанных;
- среднее `weakChoiceProb`;
- гистограмма по 10 бакетам [0..1);
- сколько пройдёт фильтр для порогов `>=` 0.3 / 0.5 / 0.7 (для
  калибровки `PRECISION_MAIA_DEFAULT_THRESHOLD`, см. F1, KS-3642).
