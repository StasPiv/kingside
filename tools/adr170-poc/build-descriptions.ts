/**
 * ADR-170 рев.2 (KS-5012) — наполнение базы: ОДНО описание линии + ОДИН
 * эмбеддинг; оценка/исход/разбиение — отдельные поля вне эмбеддинга.
 *
 * Вход:  tools/adr170-poc/tree.json (KS-5009 — линии дерева; переиспользуем).
 * Выход: tools/adr170-poc/store.json — по записи на линию (§4 рев.2):
 *   root_fen, moves_uci, moves_san, description (ТОЛЬКО ходы обеих сторон),
 *   embedding (Voyage voyage-3, dim 1024) — по этому единственному описанию,
 *   eval, outcome_prob, subterms, subterms_total — хранимые поля, НЕ в тексте
 *   и НЕ в эмбеддинге.
 *
 * Описание генерируется детерминированно из ходов (§8: без LLM, без план-
 * ярлыков, без факторного пересказа подкомпонент).
 *
 * Запуск: npx tsx tools/adr170-poc/build-descriptions.ts
 */
import { readFile, writeFile } from 'node:fs/promises';

const TREE = '/project/tools/adr170-poc/tree.json';
const OUT = '/project/tools/adr170-poc/store.json';
const ENV = '/project/.env';
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';
const DIM = 1024;

const PIECE_RU: Record<string, string> = {
  N: 'конь',
  B: 'слон',
  R: 'ладья',
  Q: 'ферзь',
  K: 'король',
};

interface Branch {
  id: string;
  root_fen: string;
  moves_uci: string[];
  moves_san: string[];
  leaf_fen: string;
  depth: number;
  stop_reason: string;
  source: string[];
  eval: number | null;
  outcome_prob: { white: number; draw: number; black: number } | null;
  subterms: Record<string, { mg: number; eg: number }>;
  subterms_total: { mg: number; eg: number; v: number };
}
interface Tree {
  baseline: {
    root_fen: string;
    eval: number | null;
    outcome_prob: { white: number; draw: number; black: number } | null;
  };
  branches: Branch[];
}

// Фактическая констатация одного полухода: КТО и ЧТО делает по доске.
// Только наблюдаемое (фигура, поля from–to, взятие, шах, рокировка,
// превращение). Без оценки замысла.
function moveFactual(san: string, uci: string, isBlack: boolean): string {
  const side = isBlack ? 'чёрные' : 'белые';
  const check = /#/.test(san)
    ? ' с шахом и матом'
    : /\+/.test(san)
      ? ' с шахом'
      : '';
  if (/^O-O-O/.test(san)) return `${side} делают длинную рокировку${check}`;
  if (/^O-O/.test(san)) return `${side} делают короткую рокировку${check}`;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promoLetter = uci.length > 4 ? uci[4].toUpperCase() : '';
  const promo = promoLetter ? `, превращение в ${PIECE_RU[promoLetter]}` : '';
  const capture = /x/.test(san);
  const pieceLetter = /^[NBRQK]/.test(san) ? san[0] : '';
  let verb: string;
  if (!pieceLetter) {
    verb = capture ? `пешка ${from} бьёт на ${to}` : `пешка идёт ${from}–${to}`;
  } else {
    const p = PIECE_RU[pieceLetter];
    verb = capture ? `${p} ${from} бьёт на ${to}` : `${p} идёт ${from}–${to}`;
  }
  return `${side}: ${verb}${promo}${check}`;
}

// ОДНО описание линии — пересказ ходов обеих сторон, без ярлыков и факторов.
function describe(b: Branch): string {
  const parts: string[] = [];
  for (let i = 0; i < b.moves_san.length; i++) {
    parts.push(moveFactual(b.moves_san[i], b.moves_uci[i], i % 2 === 0));
  }
  return `Линия от исходной позиции: ${parts.join('; ')}.`;
}

async function readVoyageKey(): Promise<string> {
  const env = await readFile(ENV, 'utf8');
  const line = env.split('\n').find((l) => l.startsWith('VOYAGE_API_KEY='));
  if (!line) throw new Error('VOYAGE_API_KEY не найден в /project/.env');
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
      input_type: 'document',
      output_dimension: DIM,
    }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    data: { index: number; embedding: number[] }[];
  };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function main() {
  const tree: Tree = JSON.parse(await readFile(TREE, 'utf8'));
  const key = await readVoyageKey();
  console.log(`линий: ${tree.branches.length} — одно описание + один вектор на линию`);

  const descriptions = tree.branches.map(describe);

  // Один эмбеддинг на линию. Батчами по 100.
  const BATCH = 100;
  const embeddings: number[][] = [];
  for (let i = 0; i < descriptions.length; i += BATCH) {
    const emb = await embed(key, descriptions.slice(i, i + BATCH));
    embeddings.push(...emb);
    console.log(`  эмбеддинг ${Math.min(i + BATCH, descriptions.length)}/${descriptions.length}`);
  }

  const records = tree.branches.map((b, i) => ({
    id: b.id,
    root_fen: b.root_fen,
    moves_uci: b.moves_uci,
    moves_san: b.moves_san,
    leaf_fen: b.leaf_fen,
    depth: b.depth,
    stop_reason: b.stop_reason,
    source: b.source,
    // Кодируется вектором:
    description: descriptions[i],
    embedding: embeddings[i],
    // Хранимые поля ВНЕ эмбеддинга:
    eval: b.eval,
    outcome_prob: b.outcome_prob,
    subterms: b.subterms,
    subterms_total: b.subterms_total,
  }));

  const output = {
    meta: {
      adr: 'ADR-170 рев.2',
      task: 'KS-5012',
      root_fen: tree.baseline.root_fen,
      embedding_model: MODEL,
      embedding_dim: DIM,
      embedding_input_type: 'document',
      description_principle:
        'одно описание линии — только ходы обеих сторон, без ярлыков и факторов; eval/outcome_prob/subterms — отдельные поля вне эмбеддинга',
      branch_count: records.length,
    },
    baseline: {
      root_fen: tree.baseline.root_fen,
      eval: tree.baseline.eval,
      outcome_prob: tree.baseline.outcome_prob,
    },
    records,
  };
  await writeFile(OUT, JSON.stringify(output));
  console.log(`\nГотово: ${records.length} записей (1 описание + 1 вектор каждая).`);
  console.log('файл:', OUT);
  console.log('\nПримеры описаний:');
  console.log(' •', descriptions[0]);
  const multi = tree.branches.findIndex((b) => b.moves_san.length >= 3);
  if (multi >= 0) console.log(' •', descriptions[multi]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
