/**
 * Эталонный тестовый набор для распознавания диаграмм Майзелиса.
 *
 * Каждая запись — пара (image, expected_fen_board), где image — путь
 * относительно `/tmp/courses/parsed/primer/images/` (источник: pdf-парсинг
 * учебника Капабланки в редакции Майзелиса). Эталон верифицирован
 * визуально по картинке (не по YAML урока — там встречаются ручные
 * ошибки, которые задача KS-2028 как раз и должна устранять).
 *
 * 21 кейс. Покрытие:
 *   - начальная позиция (id0, id12);
 *   - простые «обучающие» расстановки одной фигуры (id2..id10);
 *   - сложные позиции из главы 1 (id14..id24);
 *   - повторяющиеся диаграммы из главы 1 после рокировки (id17, id19);
 *   - en-passant пример (id37, id38);
 *   - окончания глав 2 (id39, id73, id108) — другой стиль рисунка фигур
 *     (другой шрифт короля), важно для проверки multi-source шаблонов;
 *   - пустая доска с координатной разметкой (id21).
 */

export interface RecognitionFixture {
  /** ID картинки в `/tmp/courses/parsed/primer/images/Autogen_eBook_id<id>.jpg` */
  imageId: number;
  /** Ожидаемый FEN-board (без status-части). Верифицирован визуально. */
  expectedFenBoard: string;
  /** Краткое описание для отладки. */
  description: string;
}

export const FIXTURES: RecognitionFixture[] = [
  { imageId: 0,   expectedFenBoard: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', description: 'Глава 1, диаграмма 1: начальная позиция' },
  { imageId: 12,  expectedFenBoard: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', description: 'Глава 1, диаграмма 7: начальная позиция (повтор)' },
  { imageId: 2,   expectedFenBoard: '8/8/8/2R5/4R3/8/8/8',                          description: 'Глава 1, диаграмма 2: две белые ладьи' },
  { imageId: 4,   expectedFenBoard: '8/8/8/1B2B3/8/8/8/8',                          description: 'Глава 1, диаграмма 3: два белых слона' },
  { imageId: 6,   expectedFenBoard: '8/8/8/4Q3/8/8/8/8',                            description: 'Глава 1, диаграмма 4: белый ферзь' },
  { imageId: 8,   expectedFenBoard: '8/8/8/8/3N4/8/8/8',                            description: 'Глава 1, диаграмма 5: белый конь' },
  { imageId: 10,  expectedFenBoard: '8/8/8/8/8/4K3/8/8',                            description: 'Глава 1, диаграмма 6: белый король' },
  { imageId: 14,  expectedFenBoard: 'Q3k3/7R/8/8/1n4p1/1b6/1Pp2q1P/2K5',            description: 'Глава 1, диаграмма 9: матовая позиция' },
  { imageId: 15,  expectedFenBoard: '1R3nk1/5p1p/5B1P/8/6K1/8/8/8',                 description: 'Глава 1, диаграмма 10: пат (YAML с ошибкой!)' },
  { imageId: 16,  expectedFenBoard: 'r2qk2r/pppnbppp/3p1n2/4p3/2BPP1b1/2NQ1N2/PPP2PPP/R1B1K2R', description: 'Глава 1, диаграмма 11: рокировка-сетап (YAML с ошибкой)' },
  { imageId: 17,  expectedFenBoard: 'r2qk2r/pppnbppp/3p1n2/4p3/2BPP1b1/2NQ1N2/PPP2PPP/R1B2RK1', description: 'Глава 1, диаграмма 12: после короткой рокировки' },
  { imageId: 18,  expectedFenBoard: 'r2qk2r/pp1nbppp/2pp1n2/4p3/2BPP1b1/2N1BN2/PPPQ1PPP/R3K2R',  description: 'Глава 1, диаграмма 13: длинная рокировка-сетап' },
  { imageId: 19,  expectedFenBoard: 'r2qk2r/pppnbppp/3p1n2/4p3/2BPP1b1/2N1BN2/PPPQ1PPP/2KR3R',  description: 'Глава 1, диаграмма 14: после длинной рокировки' },
  { imageId: 20,  expectedFenBoard: 'rn1qk2r/p2nbppp/bp2p3/2ppP3/3P4/1BN1BN2/PPP2PPP/R2QK2R',   description: 'Глава 1, диаграмма 15: рокировка под ударом слона' },
  { imageId: 21,  expectedFenBoard: '8/8/8/8/8/8/8/8',                              description: 'Глава 1, диаграмма 16: пустая доска с координатами' },
  { imageId: 24,  expectedFenBoard: '2kq4/2pn3r/1pRp1b2/1P1PR3/Q2K1PBr/2N5/8/8',    description: 'Глава 1, диаграмма 17: сложная позиция для нотации' },
  { imageId: 37,  expectedFenBoard: '2qrr1k1/ppb1nppp/2p1bn2/3pN3/2PPpP2/2N1B3/PPB1Q1PP/3R1RK1', description: 'Глава 1, диаграмма 18: до взятия на проходе' },
  { imageId: 38,  expectedFenBoard: '2qrr1k1/ppb1nppp/2p1bn2/3pN3/2PP4/2N1Bp2/PPB1Q1PP/3R1RK1',  description: 'Глава 1, диаграмма 19: после взятия на проходе' },
  { imageId: 39,  expectedFenBoard: '7k/8/8/8/8/8/8/R6K',                           description: 'Глава 2: мат ладьёй и королём (другой стиль фигур)' },
  { imageId: 73,  expectedFenBoard: '8/8/8/4k3/8/8/8/4K2R',                         description: 'Глава 2: ладья + король против короля' },
  { imageId: 108, expectedFenBoard: '7k/8/8/8/8/8/8/2B1KB2',                        description: 'Глава 2: два слона + король против короля' },
];

export const IMAGES_BASE_PATH = '/tmp/courses/parsed/primer/images';

export function imagePath(imageId: number): string {
  return `${IMAGES_BASE_PATH}/Autogen_eBook_id${imageId}.jpg`;
}
