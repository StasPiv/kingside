/**
 * ADR-170 PoC (KS-5010) — описания веток + эмбеддинги Voyage + хранилище.
 *
 * Вход:  tools/adr170-poc/tree.json (KS-5009 — дерево веток).
 * Выход: tools/adr170-poc/store.json (записи §4 + description×3 стиля +
 *        embedding×3 стиля). Плоский файл — минимальное хранилище (§6),
 *        pgvector не нужен (косинус-поиск в KS-5011 по этому файлу).
 *
 * Три стиля абстракции (§7 — это измерение, не пред-решение):
 *   raw           — сырой пересказ ходов;
 *   plan          — план-обобщение (замысел линии, план-лексика);
 *   plan_subterms — план + ключевые подкомпоненты (что меняется в оценке).
 *
 * Эмбеддинг: Voyage voyage-3, output_dimension 1024, input_type=document.
 * Ключ VOYAGE_API_KEY из /project/.env.
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
const STYLES = ['raw', 'plan', 'plan_subterms'] as const;
type Style = (typeof STYLES)[number];

// ---------------------------------------------------------------------------
interface Branch {
  id: string;
  root_fen: string;
  moves_uci: string[];
  moves_san: string[];
  leaf_fen: string;
  depth: number;
  stop_reason: string;
  source: string[];
  maia_prob: number | null;
  sf_rank: number | null;
  eval: number | null;
  outcome_prob: { white: number; draw: number; black: number } | null;
  subterms: Record<string, { mg: number; eg: number }>;
  subterms_total: { mg: number; eg: number; v: number };
}
interface Tree {
  meta: Record<string, unknown>;
  baseline: {
    root_fen: string;
    eval: number | null;
    outcome_prob: { white: number; draw: number; black: number } | null;
    subterms: Record<string, { mg: number; eg: number }>;
  };
  branches: Branch[];
}

// ---------------------------------------------------------------------------
// Русские имена фигур и подкомпонент (план-лексика).
const SUBTERM_RU: Record<string, string> = {
  pawn_connected: 'связанные пешки',
  pawn_doubled: 'сдвоенные пешки',
  pawn_isolated: 'изолированная пешка',
  pawn_backward: 'отсталая пешка',
  pawn_blocked: 'заблокированные пешки',
  king_shelter_strength: 'пешечный щит короля',
  king_blocked_storm: 'заблокированный пешечный штурм',
  king_unblocked_storm: 'открытый пешечный штурм на короля',
  king_on_file: 'король на открытой линии',
  outpost_knight: 'форпост коня',
  outpost_bishop: 'форпост слона',
  minor_behind_pawn: 'фигура за пешкой',
  bishop_pawns: 'слон и свои пешки',
  bishop_long_diagonal: 'слон на большой диагонали',
  rook_on_open_file: 'ладья на открытой линии',
  rook_on_closed_file: 'ладья на закрытой линии',
  queen_weak: 'уязвимый ферзь',
  king_safety_pawn: 'пешечное прикрытие короля',
  king_danger: 'опасность королю',
  king_safe_check_rook: 'угроза шаха ладьёй',
  king_safe_check_queen: 'угроза шаха ферзём',
  king_safe_check_bishop: 'угроза шаха слоном',
  king_safe_check_knight: 'угроза шаха конём',
  king_pawnless_flank: 'фланг короля без пешек',
  king_flank_attacks: 'атака на фланге короля',
  threat_by_minor: 'угроза лёгкой фигурой',
  threat_by_rook: 'угроза ладьёй',
  threat_hanging: 'висячие фигуры',
  threat_by_safe_pawn: 'угроза защищённой пешкой',
  threat_by_pawn_push: 'угроза продвижением пешки',
  threat_knight_on_queen: 'конь нападает на ферзя',
  threat_slider_on_queen: 'дальнобойная фигура на ферзя',
  passed_rank: 'проходная пешка',
  passed_path_advance: 'продвижение проходной',
  space: 'пространство',
  mobility_knight: 'подвижность коня',
  mobility_bishop: 'подвижность слона',
  mobility_rook: 'подвижность ладьи',
  mobility_queen: 'подвижность ферзя',
  king_attackers_count: 'число атакующих короля',
  king_attackers_weight: 'вес атаки на короля',
  material: 'материал',
  imbalance: 'дисбаланс материала',
  psqt_pawn: 'расположение пешек',
  psqt_knight: 'расположение коней',
  psqt_bishop: 'расположение слонов',
  psqt_rook: 'расположение ладей',
  psqt_queen: 'расположение ферзя',
  psqt_king: 'расположение короля',
};

const PIECE_RU: Record<string, string> = {
  N: 'конь',
  B: 'слон',
  R: 'ладья',
  Q: 'ферзь',
  K: 'король',
};

// ---------------------------------------------------------------------------
// Классификация плана по ходу чёрных из корня (первый ход ветки).
function planFamily(san: string): string {
  const s = san.replace(/[+#]/, '');
  if (/^c5$/.test(s)) return 'подрыв пешечного центра ходом …c5';
  if (/^e5$/.test(s) || /^f6$/.test(s) || /^f5$/.test(s))
    return 'подрыв центра';
  if (/^[gh][45678]$/.test(s))
    return 'игра на королевском фланге пешками';
  if (/^[ab][456]$/.test(s) || /^b5$/.test(s))
    return 'игра на ферзевом фланге пешками';
  if (/^Bb4/.test(san)) return 'связка ходом …Cb4 с шахом';
  if (/^B/.test(s)) return 'перевод слона';
  if (/^N/.test(s)) return 'развитие коня';
  if (/^Q/.test(s)) return 'вывод ферзя';
  if (/^O-O-O/.test(s)) return 'длинная рокировка';
  if (/^O-O/.test(s)) return 'короткая рокировка';
  return `ход …${san}`;
}

function evalPhrase(ev: number | null): string {
  if (ev === null) return 'оценка недоступна';
  const a = Math.abs(ev);
  const who = ev > 0 ? 'в пользу белых' : ev < 0 ? 'в пользу чёрных' : 'равенство';
  let mag = 'примерно равно';
  if (a >= 0.1 && a < 0.5) mag = 'небольшой перевес';
  else if (a >= 0.5 && a < 1.2) mag = 'ощутимый перевес';
  else if (a >= 1.2 && a < 3) mag = 'значительный перевес';
  else if (a >= 3) mag = 'решающий перевес';
  const sign = ev > 0 ? '+' : '';
  return ev === 0
    ? `оценка ${sign}${ev.toFixed(2)} (равенство)`
    : `оценка ${sign}${ev.toFixed(2)} (${mag} ${who})`;
}

function outcomePhrase(
  op: { white: number; draw: number; black: number } | null,
): string {
  if (!op) return '';
  const pct = (x: number) => Math.round(x * 100);
  return `вероятности исхода: белые ${pct(op.white)}%, ничья ${pct(op.draw)}%, чёрные ${pct(op.black)}%`;
}

// SAN → человеческая фраза хода (для сырого пересказа).
function sanToRu(san: string): string {
  let s = san;
  const check = /\+/.test(s) ? ' с шахом' : /#/.test(s) ? ' с матом' : '';
  s = s.replace(/[+#]/g, '');
  if (s === 'O-O') return 'короткая рокировка' + check;
  if (s === 'O-O-O') return 'длинная рокировка' + check;
  const pieceLetter = /^[NBRQK]/.test(s) ? s[0] : '';
  const piece = pieceLetter ? PIECE_RU[pieceLetter] : 'пешка';
  const capture = /x/.test(s) ? 'бьёт на ' : 'идёт на ';
  const dest = s.match(/([a-h][1-8])(=([NBRQ]))?$/);
  const to = dest ? dest[1] : s;
  const promo = dest && dest[3] ? `, превращение в ${PIECE_RU[dest[3]]}` : '';
  return `${piece} ${capture}${to}${promo}${check}`;
}

// Топ-N подкомпонент по модулю дельты к корню (кроме psqt-шума в тексте).
function topSubterms(
  st: Record<string, { mg: number; eg: number }>,
  base: Record<string, { mg: number; eg: number }>,
  n: number,
): { id: string; delta: number }[] {
  return Object.keys(st)
    .filter((k) => !k.startsWith('psqt_'))
    .map((k) => ({
      id: k,
      delta: st[k].mg + st[k].eg - (base[k].mg + base[k].eg),
    }))
    .filter((x) => Math.abs(x.delta) > 0.05)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, n);
}

// ---------------------------------------------------------------------------
function moveList(san: string[]): string {
  // Нумерация полуходов от корня (ход чёрных первый).
  const parts: string[] = [];
  for (let i = 0; i < san.length; i++) {
    const mover = i % 2 === 0 ? 'чёрные' : 'белые';
    parts.push(`${mover}: ${sanToRu(san[i])}`);
  }
  return parts.join('; ');
}

function descRaw(b: Branch): string {
  return `Линия от исходной позиции (Каро-Канн, продвижение центра): ${moveList(
    b.moves_san,
  )}. Ходы (UCI): ${b.moves_uci.join(' ')}. ${evalPhrase(b.eval)}.`;
}

function descPlan(b: Branch): string {
  const fam = planFamily(b.moves_san[0]);
  const cont =
    b.moves_san.length > 1
      ? ` Продолжение: ${b.moves_san.slice(1).join(' ')}.`
      : '';
  return `План чёрных: ${fam}.${cont} Итог линии: ${evalPhrase(
    b.eval,
  )}; ${outcomePhrase(b.outcome_prob)}.`;
}

function descPlanSubterms(b: Branch, base: Tree['baseline']): string {
  const fam = planFamily(b.moves_san[0]);
  const tops = topSubterms(b.subterms, base.subterms, 4);
  const named = tops
    .map((t) => {
      const ru = SUBTERM_RU[t.id] ?? t.id;
      const dir = t.delta > 0 ? 'растёт' : 'снижается';
      return `${ru} (${dir})`;
    })
    .join(', ');
  return `План чёрных: ${fam}. Ходы: ${b.moves_san.join(
    ' ',
  )}. ${evalPhrase(b.eval)}. Меняются позиционные факторы: ${named}. ${outcomePhrase(
    b.outcome_prob,
  )}.`;
}

function buildDescriptions(
  b: Branch,
  base: Tree['baseline'],
): Record<Style, string> {
  return {
    raw: descRaw(b),
    plan: descPlan(b),
    plan_subterms: descPlanSubterms(b, base),
  };
}

// ---------------------------------------------------------------------------
async function readVoyageKey(): Promise<string> {
  const env = await readFile(ENV, 'utf8');
  const line = env.split('\n').find((l) => l.startsWith('VOYAGE_API_KEY='));
  if (!line) throw new Error('VOYAGE_API_KEY не найден в /project/.env');
  return line
    .slice('VOYAGE_API_KEY='.length)
    .trim()
    .replace(/^["']|["']$/g, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function embedBatch(
  key: string,
  texts: string[],
  inputType: 'document' | 'query' = 'document',
): Promise<number[][]> {
  // Free-tier Voyage: 3 RPM / 10K TPM → ретрай с бэкоффом на 429.
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
        input_type: inputType,
        output_dimension: DIM,
      }),
    });
    if (res.status === 429) {
      const wait = 25000 + attempt * 10000;
      console.log(`  429 rate limit, жду ${wait / 1000}с (попытка ${attempt + 1})`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  throw new Error('Voyage: превышены попытки при 429');
}

// ---------------------------------------------------------------------------
async function main() {
  const tree: Tree = JSON.parse(await readFile(TREE, 'utf8'));
  const key = await readVoyageKey();
  console.log(`веток: ${tree.branches.length}, стилей: ${STYLES.length}`);

  // Описания для всех веток.
  const descs = tree.branches.map((b) =>
    buildDescriptions(b, tree.baseline),
  );

  // Плоский список текстов на эмбеддинг (branch × style), запоминаем порядок.
  const flatTexts: string[] = [];
  const flatKey: { bi: number; style: Style }[] = [];
  descs.forEach((d, bi) => {
    for (const style of STYLES) {
      flatTexts.push(d[style]);
      flatKey.push({ bi, style });
    }
  });

  // Эмбеддинг батчами. Free-tier: 3 RPM / 10K TPM → мелкие батчи + троттл.
  const BATCH = 20;
  const THROTTLE = 25000; // ~ до 3 запросов/мин
  const embeddings: number[][] = [];
  for (let i = 0; i < flatTexts.length; i += BATCH) {
    if (i > 0) await sleep(THROTTLE);
    const chunk = flatTexts.slice(i, i + BATCH);
    const emb = await embedBatch(key, chunk);
    embeddings.push(...emb);
    console.log(`  эмбеддинг ${Math.min(i + BATCH, flatTexts.length)}/${flatTexts.length}`);
  }

  // Сборка записей.
  const records = tree.branches.map((b, bi) => {
    const descriptions = descs[bi];
    const embMap: Record<Style, number[]> = {} as Record<Style, number[]>;
    flatKey.forEach((fk, idx) => {
      if (fk.bi === bi) embMap[fk.style] = embeddings[idx];
    });
    return {
      id: b.id,
      root_fen: b.root_fen,
      moves_uci: b.moves_uci,
      moves_san: b.moves_san,
      leaf_fen: b.leaf_fen,
      depth: b.depth,
      stop_reason: b.stop_reason,
      source: b.source,
      eval: b.eval,
      outcome_prob: b.outcome_prob,
      subterms: b.subterms,
      subterms_total: b.subterms_total,
      descriptions,
      embeddings: embMap,
    };
  });

  const output = {
    meta: {
      adr: 'ADR-170',
      task: 'KS-5010',
      root_fen: tree.baseline.root_fen,
      embedding_model: MODEL,
      embedding_dim: DIM,
      embedding_input_type: 'document',
      styles: STYLES,
      style_notes: {
        raw: 'сырой пересказ ходов',
        plan: 'план-обобщение (замысел линии)',
        plan_subterms: 'план + ключевые позиционные подкомпоненты',
      },
      branch_count: records.length,
      note: 'фаза C (поиск+ответ) — KS-5011',
    },
    baseline: {
      root_fen: tree.baseline.root_fen,
      eval: tree.baseline.eval,
      outcome_prob: tree.baseline.outcome_prob,
    },
    records,
  };
  await writeFile(OUT, JSON.stringify(output));
  console.log(
    `\nГотово: ${records.length} веток × ${STYLES.length} стиля = ${flatTexts.length} эмбеддингов (${MODEL}, dim ${DIM}).`,
  );
  console.log('файл:', OUT);
  console.log('\nПример описаний (br1):');
  for (const s of STYLES) console.log(` [${s}] ${descs[0][s]}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
