/**
 * KS-4166 (ADR-128 §11.14): локальное хранилище мастерской для гостя.
 *
 * Метаданные PGN-файлов держим в `localStorage` (быстрый список без
 * await/IDB), сырой PGN — в IndexedDB, чтобы не упереться в 5–10 МБ
 * лимит localStorage на больших файлах. После логина гость может
 * перенести данные на сервер (см. KS-4166 §6 — отдельная задача).
 *
 * Структура localStorage:
 *   key = `kingside.workshop.guest.pgn-files`
 *   val = JSON.stringify([{ id, name, gameCount, size, uploadedAt }, ...])
 *
 * IndexedDB:
 *   db   = `kingside-workshop-guest`
 *   store = `pgn-files`   key = id (string), value = string (PGN content)
 */
import { Chess } from 'chess.js';

export interface GuestPgnFile {
  id: string;
  name: string;
  gameCount: number;
  size: number;
  uploadedAt: string;
}

export interface GuestPgnGame {
  id: string;
  index: number;
  white: string;
  black: string;
  result: string;
  date: string | null;
  pgn: string;
}

const LS_KEY = 'kingside.workshop.guest.pgn-files';
const DB_NAME = 'kingside-workshop-guest';
const DB_VERSION = 1;
const STORE_PGN = 'pgn-files';

// ─── localStorage helpers ────────────────────────────────────────────

function readList(): GuestPgnFile[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is GuestPgnFile =>
        !!f &&
        typeof f.id === 'string' &&
        typeof f.name === 'string' &&
        typeof f.gameCount === 'number' &&
        typeof f.size === 'number' &&
        typeof f.uploadedAt === 'string',
    );
  } catch {
    return [];
  }
}

function writeList(files: GuestPgnFile[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(files));
  } catch {
    /* quota — ignore, IndexedDB всё равно хранит контент */
  }
}

// ─── IndexedDB helpers ───────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PGN)) {
        db.createObjectStore(STORE_PGN);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(id: string, pgn: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_PGN, 'readwrite');
    tx.objectStore(STORE_PGN).put(pgn, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet(id: string): Promise<string | null> {
  const db = await openDb();
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE_PGN, 'readonly');
      const req = tx.objectStore(STORE_PGN).get(id);
      req.onsuccess = () =>
        resolve(typeof req.result === 'string' ? req.result : null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbDelete(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_PGN, 'readwrite');
    tx.objectStore(STORE_PGN).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// ─── PGN parsing (lightweight) ───────────────────────────────────────

/**
 * Разбиваем PGN на отдельные партии. Стандартный PGN-разделитель —
 * пустая строка между блоком тегов следующей партии и блоком ходов
 * предыдущей. Используем `[Event …` как якорь и аккумулируем строки
 * пока не встретим следующий `[Event` после строки ходов.
 */
function splitPgnGames(pgn: string): string[] {
  const normalized = pgn.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  // Делим по началу нового блока тегов: `\n\n[`.
  const chunks = normalized
    .split(/\n\n(?=\[)/g)
    .map((c) => c.trim())
    .filter(Boolean);
  // Соседние «теги-без-ходов» + «ходы-без-тегов» из-за чанкования
  // объединяем обратно: если блок не содержит хотя бы одного `[Event` или
  // не содержит ходов, склеиваем с соседним.
  const games: string[] = [];
  let buf = '';
  for (const c of chunks) {
    if (!buf) {
      buf = c;
      continue;
    }
    if (!/\[Event\b/.test(c)) {
      buf = `${buf}\n\n${c}`;
    } else {
      games.push(buf);
      buf = c;
    }
  }
  if (buf) games.push(buf);
  return games;
}

function readTag(pgn: string, tag: string): string | null {
  const re = new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`);
  const m = re.exec(pgn);
  return m ? m[1] : null;
}

function parseGameMeta(pgn: string, index: number): GuestPgnGame {
  const white = readTag(pgn, 'White') ?? '?';
  const black = readTag(pgn, 'Black') ?? '?';
  const result = readTag(pgn, 'Result') ?? '*';
  const date = readTag(pgn, 'Date');
  return {
    id: `g${index}`,
    index,
    white,
    black,
    result,
    date,
    pgn,
  };
}

function countValidGames(games: GuestPgnGame[]): number {
  let count = 0;
  for (const g of games) {
    try {
      const c = new Chess();
      c.loadPgn(g.pgn, { strict: false });
      count++;
    } catch {
      /* ignore — невалидную партию не учитываем, но не теряем */
    }
  }
  return count;
}

function genId(): string {
  return `f${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Public API ──────────────────────────────────────────────────────

export const guestWorkshopStore = {
  listFiles(): GuestPgnFile[] {
    return readList().sort((a, b) =>
      a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0,
    );
  },

  async addFile(name: string, pgnContent: string): Promise<GuestPgnFile> {
    const id = genId();
    const games = splitPgnGames(pgnContent).map((g, i) => parseGameMeta(g, i));
    const gameCount = countValidGames(games);
    const file: GuestPgnFile = {
      id,
      name,
      gameCount,
      size: pgnContent.length,
      uploadedAt: new Date().toISOString(),
    };
    await idbPut(id, pgnContent);
    writeList([file, ...readList()]);
    return file;
  },

  async deleteFile(id: string): Promise<void> {
    writeList(readList().filter((f) => f.id !== id));
    try {
      await idbDelete(id);
    } catch {
      /* ignore */
    }
  },

  renameFile(id: string, newName: string): void {
    const list = readList();
    const next = list.map((f) => (f.id === id ? { ...f, name: newName } : f));
    writeList(next);
  },

  async getGames(id: string): Promise<GuestPgnGame[]> {
    const pgn = await idbGet(id);
    if (!pgn) return [];
    return splitPgnGames(pgn).map((g, i) => parseGameMeta(g, i));
  },

  async deleteGame(id: string, gameId: string): Promise<GuestPgnGame[]> {
    const games = await this.getGames(id);
    const remaining = games.filter((g) => g.id !== gameId);
    const joined = remaining.map((g) => g.pgn).join('\n\n');
    await idbPut(id, joined);
    const list = readList().map((f) =>
      f.id === id ? { ...f, gameCount: remaining.length, size: joined.length } : f,
    );
    writeList(list);
    return remaining;
  },
};
