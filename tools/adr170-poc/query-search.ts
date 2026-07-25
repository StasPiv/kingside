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

const STORE = '/project/tools/adr170-poc/store.json';
const OUT = '/project/tools/adr170-poc/phase-c.json';
const ENV = '/project/.env';
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';
const DIM = 1024;
const TOPK = 5;

// 3–5 русских запросов-планов по тестовой позиции.
const QUERIES = [
  'надвинуть пешки королевского фланга и атаковать короля',
  'подорвать пешечный центр белых',
  'разменять фигуры и упростить позицию',
  'спокойно развить фигуры и рокировать в безопасность',
  'начать активную игру на ферзевом фланге',
];

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
    const top = store.records
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
    return { query: q, top5: top };
  });

  await writeFile(
    OUT,
    JSON.stringify({ model: MODEL, dim: DIM, topk: TOPK, results }, null, 2),
  );

  for (const r of results) {
    console.log(`\n════ ЗАПРОС: ${r.query}`);
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
