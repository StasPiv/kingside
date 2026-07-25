/**
 * ADR-170 PoC (KS-5011) — фаза C: поиск плана + материал для ответа.
 *
 * Вход:  tools/adr170-poc/store.json (KS-5010 — записи + эмбеддинги×3 стиля).
 * Выход: tools/adr170-poc/phase-c.json — по каждому русскому запросу-плану:
 *   top-5 веток по косинусу для КАЖДОГО стиля описаний (сравнение стилей),
 *   отбор + ранжирование по сохранённой оценке (eval), лучшая альтернатива.
 *
 * Ответ LLM (§7: линии + оценка + причина из подкомпонент + альтернатива)
 * формулируется агентом в сессии по этому материалу (§8) — в записке
 * phase-c-note.md.
 *
 * Эмбеддинг запроса: Voyage voyage-3, dim 1024, input_type=query (важно:
 * document/query асимметрия). Ключ VOYAGE_API_KEY из /project/.env.
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
const STYLES = ['raw', 'plan', 'plan_subterms'] as const;
type Style = (typeof STYLES)[number];
const TOPK = 5;

// 5 русских запросов-планов по тестовой позиции (Каро-Канн, ход чёрных).
const QUERIES = [
  'надвинуть пешки королевского фланга и атаковать короля',
  'подорвать пешечный центр белых',
  'разменять фигуры и упростить позицию',
  'спокойно развить фигуры и рокировать в безопасность',
  'начать активную игру на ферзевом фланге',
];

interface Record {
  id: string;
  moves_san: string[];
  moves_uci: string[];
  eval: number | null;
  outcome_prob: { white: number; draw: number; black: number } | null;
  subterms: globalThis.Record<string, { mg: number; eg: number }>;
  descriptions: globalThis.Record<Style, string>;
  embeddings: globalThis.Record<Style, number[]>;
}
interface Store {
  meta: globalThis.Record<string, unknown>;
  baseline: { eval: number | null };
  records: Record[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readKey(): Promise<string> {
  const env = await readFile(ENV, 'utf8');
  const line = env.split('\n').find((l) => l.startsWith('VOYAGE_API_KEY='));
  if (!line) throw new Error('VOYAGE_API_KEY не найден');
  return line.slice('VOYAGE_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
}

async function embed(key: string, texts: string[]): Promise<number[][]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: texts,
        model: MODEL,
        input_type: 'query', // асимметрия query/document
        output_dimension: DIM,
      }),
    });
    if (res.status === 429) {
      const wait = 25000 + attempt * 10000;
      console.log(`  429, жду ${wait / 1000}с`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  throw new Error('Voyage: превышены попытки 429');
}

function cosine(a: number[], b: number[]): number {
  // Эмбеддинги Voyage нормированы → dot = cosine.
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function topDeltaSubterms(
  st: globalThis.Record<string, { mg: number; eg: number }>,
  base: globalThis.Record<string, { mg: number; eg: number }>,
  n: number,
) {
  return Object.keys(st)
    .filter((k) => !k.startsWith('psqt_'))
    .map((k) => ({ id: k, delta: st[k].mg + st[k].eg - (base[k].mg + base[k].eg) }))
    .filter((x) => Math.abs(x.delta) > 0.05)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, n);
}

async function main() {
  const store: Store = JSON.parse(await readFile(STORE, 'utf8'));
  const key = await readKey();
  // baseline подкомпоненты корня — из tree.json (для дельт «причины»).
  const tree = JSON.parse(
    await readFile('/project/tools/adr170-poc/tree.json', 'utf8'),
  );
  const baselineSub: globalThis.Record<string, { mg: number; eg: number }> =
    tree.baseline?.subterms ?? {};

  console.log(`запросов: ${QUERIES.length}, веток: ${store.records.length}`);
  const qEmb = await embed(key, QUERIES);

  const results = QUERIES.map((q, qi) => {
    const qv = qEmb[qi];
    // Поиск по каждому стилю.
    const perStyle = STYLES.map((style) => {
      const scored = store.records
        .map((r) => ({
          id: r.id,
          moves_san: r.moves_san,
          eval: r.eval,
          sim: cosine(qv, r.embeddings[style]),
          description: r.descriptions[style],
        }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, TOPK);
      return { style, hits: scored };
    });

    // Отбор кандидатов: берём top-K лучшего по поиску стиля (plan —
    // см. §9-вывод: он даёт самые высокие и чистые совпадения), затем
    // ранжируем по сохранённой оценке (ход чёрных → чем ниже eval для
    // белых, тем лучше плану чёрных). Объединение всех стилей сюда НЕ
    // берём — top-K сырого стиля (raw) вносит нерелевантный шум.
    const BEST_STYLE: Style = 'plan';
    const chosenStyle =
      perStyle.find((p) => p.style === BEST_STYLE) ?? perStyle[0];
    const pool = chosenStyle.hits.map((h) => ({
      id: h.id,
      moves_san: h.moves_san,
      eval: h.eval,
      bestSim: h.sim,
    }));
    // Ранжирование по оценке для чёрных (меньше eval белых = лучше чёрным).
    const byEvalForBlack = [...pool].sort(
      (a, b) => (a.eval ?? 0) - (b.eval ?? 0),
    );
    const best = byEvalForBlack[0];
    const worst = byEvalForBlack[byEvalForBlack.length - 1];

    const full = best
      ? store.records.find((r) => r.id === best.id)!
      : null;
    const subterms = full
      ? topDeltaSubterms(full.subterms, baselineSub, 4)
      : [];

    return {
      query: q,
      per_style: perStyle,
      pool_ranked_by_eval_for_black: byEvalForBlack,
      chosen: best
        ? {
            id: best.id,
            moves_san: best.moves_san,
            eval: best.eval,
            top_subterm_deltas: subterms,
          }
        : null,
      alternative: worst && worst.id !== best?.id
        ? { id: worst.id, moves_san: worst.moves_san, eval: worst.eval }
        : null,
    };
  });

  await writeFile(OUT, JSON.stringify({ model: MODEL, dim: DIM, results }, null, 2));

  // Человекочитаемый вывод.
  for (const r of results) {
    console.log(`\n════ ЗАПРОС: ${r.query}`);
    for (const ps of r.per_style) {
      console.log(`  [${ps.style}]`);
      for (const h of ps.hits) {
        console.log(
          `     sim=${h.sim.toFixed(3)}  eval=${h.eval}  ${h.moves_san.join(' ')}`,
        );
      }
    }
    console.log(
      `  → выбор (лучший чёрным по eval): ${r.chosen?.moves_san.join(' ')} (eval ${r.chosen?.eval})`,
    );
    if (r.alternative)
      console.log(
        `  → альтернатива: ${r.alternative.moves_san.join(' ')} (eval ${r.alternative.eval})`,
      );
  }
  console.log('\nфайл:', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
