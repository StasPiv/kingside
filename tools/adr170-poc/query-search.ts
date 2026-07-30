/**
 * ADR-170 рев.2 (KS-5012) — фаза C: векторный поиск топ-5 линий + материал ответа.
 *
 * Вход:  tools/adr170-poc/store.json (одно описание + один вектор на линию).
 * Выход: tools/adr170-poc/phase-c.json — по каждому русскому запросу-плану:
 *   топ-5 линий по косинусу к их описаниям + сохранённая оценка (eval),
 *   outcome_prob и разбиение конечной позиции (subterms) отобранных линий.
 *
 * Ответ LLM (§5 шаг 8: отобранные линии + их оценка) формулируется агентом
 * в сессии по этому материалу — в записке phase-c-note.md.
 *
 * Эмбеддинг запроса: Voyage voyage-3, dim 1024, input_type=query.
 *
 * Запуск: npx tsx tools/adr170-poc/query-search.ts
 */
import { readFile, writeFile } from 'node:fs/promises';

const STORE =
  process.env.ADR170_STORE || '/project/tools/adr170-poc/store.json';
const OUT = process.env.ADR170_PHASE_C || '/project/tools/adr170-poc/phase-c.json';
const ENV = '/project/.env';
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';
const DIM = 1024;
const TOPK = 5;

// 3–5 русских запросов-планов по тестовой позиции.
// Последний — запрос про КОНКРЕТНЫЙ ход: проверка точного фильтра по moves_san
// (слабое место #4 phase-c-note: вектор-по-тексту буквальный поиск не делает).
const QUERIES = [
  'надвинуть пешки королевского фланга и атаковать короля',
  'подорвать пешечный центр белых',
  'разменять фигуры и упростить позицию',
  'спокойно развить фигуры и рокировать в безопасность',
  'начать активную игру на ферзевом фланге',
  'покажи линию с ходом dxc4',
];

/**
 * Извлекает из запроса упоминания конкретных ходов: SAN (Rc4, Qxc4, dxc4,
 * O-O, e4) и UCI (d5c4). Латинские токены хода стоят в кириллическом
 * запросе особняком, ложные срабатывания на русских словах маловероятны.
 * Нормализация: срез хвостовых +/# у SAN, нижний регистр у UCI.
 */
const SAN_RE =
  /\b(?:O-O-O|O-O|[KQRBN][a-h1-8]{1,4}|[a-h]x?[a-h]?[1-8](?:=[QRBN])?)[+#]?\b/g;
const UCI_RE = /\b[a-h][1-8][a-h][1-8][qrbn]?\b/g;

function normSan(m: string): string {
  return m.replace(/[+#]$/, '');
}

function extractMoveMentions(query: string): { san: Set<string>; uci: Set<string> } {
  const san = new Set<string>();
  const uci = new Set<string>();
  for (const m of query.match(UCI_RE) ?? []) uci.add(m.toLowerCase());
  for (const m of query.match(SAN_RE) ?? []) {
    const n = normSan(m);
    // UCI-токен (e.g. d5c4) SAN_RE тоже ловит как «d5c4»? нет — SAN_RE не
    // покрывает 4-символьный [a-h][1-8][a-h][1-8]. Но короткие ходы вроде
    // «e4» валидны как SAN. Не кладём в san то, что уже распознано UCI.
    if (!uci.has(n.toLowerCase())) san.add(n);
  }
  return { san, uci };
}

/** Содержит ли линия хотя бы один из упомянутых ходов (SAN или UCI). */
function lineHasMention(
  rec: Rec,
  mentions: { san: Set<string>; uci: Set<string> },
): boolean {
  if (mentions.san.size === 0 && mentions.uci.size === 0) return false;
  const san = new Set(rec.moves_san.map(normSan));
  const uci = new Set(rec.moves_uci.map((u) => u.toLowerCase()));
  for (const m of mentions.san) if (san.has(m)) return true;
  for (const m of mentions.uci) if (uci.has(m)) return true;
  return false;
}

interface Rec {
  id: string;
  moves_san: string[];
  moves_uci: string[];
  description: string;
  embedding: number[];
  eval: number | null;
  outcome_prob: { white: number; draw: number; black: number } | null;
  subterms: Record<string, { mg: number; eg: number }>;
}
interface Store {
  baseline: { eval: number | null };
  records: Rec[];
}

async function readKey(): Promise<string> {
  const env = await readFile(ENV, 'utf8');
  const line = env.split('\n').find((l) => l.startsWith('VOYAGE_API_KEY='));
  if (!line) throw new Error('VOYAGE_API_KEY не найден');
  return line.slice('VOYAGE_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
}

async function embed(key: string, texts: string[]): Promise<number[][]> {
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      input_type: 'query',
      output_dimension: DIM,
    }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    data: { index: number; embedding: number[] }[];
  };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function cosine(a: number[], b: number[]): number {
  // Векторы Voyage нормированы → скалярное произведение = косинус.
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Топ-N подкомпонент конечной позиции по модулю (для показа разбиения).
function topSubterms(st: Record<string, { mg: number; eg: number }>, n: number) {
  return Object.keys(st)
    .filter((k) => !k.startsWith('psqt_'))
    .map((k) => ({ id: k, v: st[k].mg + st[k].eg }))
    .filter((x) => Math.abs(x.v) > 0.05)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, n);
}

async function main() {
  const store: Store = JSON.parse(await readFile(STORE, 'utf8'));
  const key = await readKey();
  console.log(`запросов: ${QUERIES.length}, линий: ${store.records.length}`);

  const qEmb = await embed(key, QUERIES);

  const results = QUERIES.map((q, qi) => {
    const qv = qEmb[qi];
    // Точный фильтр по ходу: если в запросе упомянут конкретный ход —
    // ранжируем только линии, где этот ход реально есть; пустой матч —
    // откат к полному набору (не отдаём пустоту).
    const mentions = extractMoveMentions(q);
    const hasMention = mentions.san.size > 0 || mentions.uci.size > 0;
    const filtered = hasMention
      ? store.records.filter((r) => lineHasMention(r, mentions))
      : store.records;
    const candidates = filtered.length > 0 ? filtered : store.records;
    const move_filter = {
      mentions: [...mentions.san, ...mentions.uci],
      applied: hasMention && filtered.length > 0,
      matched: filtered.length,
    };
    const top = candidates
      .map((r) => ({
        id: r.id,
        moves_san: r.moves_san,
        moves_uci: r.moves_uci,
        description: r.description,
        sim: cosine(qv, r.embedding),
        eval: r.eval,
        outcome_prob: r.outcome_prob,
        top_subterms: topSubterms(r.subterms, 5),
      }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, TOPK);
    return { query: q, move_filter, top5: top };
  });

  await writeFile(
    OUT,
    JSON.stringify({ model: MODEL, dim: DIM, topk: TOPK, results }, null, 2),
  );

  for (const r of results) {
    const mf = r.move_filter.applied
      ? ` [фильтр по ходу: ${r.move_filter.mentions.join(',')} → ${r.move_filter.matched} линий]`
      : '';
    console.log(`\n════ ЗАПРОС: ${r.query}${mf}`);
    for (const h of r.top5) {
      console.log(
        `   sim=${h.sim.toFixed(3)}  eval=${h.eval}  ${h.moves_san.join(' ')}`,
      );
    }
  }
  console.log('\nфайл:', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
