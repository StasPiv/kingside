/**
 * KS-3651 / ADR-107 rev 2 §6. Тесты subterm-labels.ts:
 *  - все 51 идентификатор `PositionalSubtermId` имеют RU+EN-описание;
 *  - `KNOWN_SUBTERM_IDS` совпадает с ключами `SUBTERM_LABELS`;
 *  - `labelForSubtermId` возвращает корректную локализацию,
 *    `null` для неизвестных id.
 */
import {
  KNOWN_SUBTERM_IDS,
  SUBTERM_LABELS,
  labelForSubtermId,
} from './subterm-labels';

// Источник истины — PositionalSubtermId в shared (51 ID, KS-3649).
// Дублирую список здесь как массив строк для прямой сверки —
// независимо от type-level union, чтобы regression на снимке.
const EXPECTED_IDS_SOURCE_OF_TRUTH = [
  // Pawns (7)
  'pawn_doubled_early',
  'pawn_connected',
  'pawn_doubled',
  'pawn_isolated',
  'pawn_backward',
  'pawn_lever_double',
  'pawn_blocked',
  // Shelter (4)
  'king_shelter_strength',
  'king_blocked_storm',
  'king_unblocked_storm',
  'king_on_file',
  // Pieces (17)
  'rook_on_king_ring',
  'bishop_on_king_ring',
  'knight_uncontested_outpost',
  'outpost_knight',
  'outpost_bishop',
  'knight_reachable_outpost',
  'minor_behind_pawn',
  'knight_king_protector_distance',
  'bishop_king_protector_distance',
  'bishop_pawns',
  'bishop_xray_pawns',
  'bishop_long_diagonal',
  'bishop_cornered',
  'rook_on_open_file',
  'rook_on_closed_file',
  'rook_trapped',
  'queen_weak',
  // King (8)
  'king_safety_pawn',
  'king_danger',
  'king_safe_check_rook',
  'king_safe_check_queen',
  'king_safe_check_bishop',
  'king_safe_check_knight',
  'king_pawnless_flank',
  'king_flank_attacks',
  // Threats (10)
  'threat_by_minor',
  'threat_by_rook',
  'threat_by_king',
  'threat_hanging',
  'threat_weak_queen_protection',
  'threat_restricted_piece',
  'threat_by_safe_pawn',
  'threat_by_pawn_push',
  'threat_knight_on_queen',
  'threat_slider_on_queen',
  // Passed (4)
  'passed_rank',
  'passed_king_proximity',
  'passed_path_advance',
  'passed_file_edge',
  // Space (1)
  'space',
];

describe('KS-3651 SUBTERM_LABELS', () => {
  it('содержит ровно 51 идентификатор (синхронизация с shared)', () => {
    expect(EXPECTED_IDS_SOURCE_OF_TRUTH).toHaveLength(51);
    expect(Object.keys(SUBTERM_LABELS)).toHaveLength(51);
  });

  it('все ожидаемые ID присутствуют в таблице (нет пропусков)', () => {
    for (const id of EXPECTED_IDS_SOURCE_OF_TRUTH) {
      expect(SUBTERM_LABELS).toHaveProperty(id);
    }
  });

  it('в таблице нет лишних ID, которых нет в ожидаемом списке', () => {
    const expected = new Set(EXPECTED_IDS_SOURCE_OF_TRUTH);
    for (const id of Object.keys(SUBTERM_LABELS)) {
      expect(expected.has(id)).toBe(true);
    }
  });

  it('каждый ID имеет непустые ru и en описания', () => {
    for (const id of Object.keys(SUBTERM_LABELS)) {
      const lab = SUBTERM_LABELS[id as keyof typeof SUBTERM_LABELS];
      expect(typeof lab.ru).toBe('string');
      expect(typeof lab.en).toBe('string');
      expect(lab.ru.length).toBeGreaterThan(0);
      expect(lab.en.length).toBeGreaterThan(0);
    }
  });

  it('KNOWN_SUBTERM_IDS совпадает с ключами SUBTERM_LABELS', () => {
    const fromLabels = new Set(Object.keys(SUBTERM_LABELS));
    expect(KNOWN_SUBTERM_IDS.size).toBe(fromLabels.size);
    for (const id of fromLabels) {
      expect(KNOWN_SUBTERM_IDS.has(id)).toBe(true);
    }
  });
});

describe('labelForSubtermId', () => {
  it('возвращает RU/EN для известного ID', () => {
    expect(labelForSubtermId('pawn_isolated', 'ru')).toBe(
      'изолированная пешка',
    );
    expect(labelForSubtermId('pawn_isolated', 'en')).toBe('isolated pawn');
    expect(labelForSubtermId('bishop_pawns', 'ru')).toMatch(/плохой слон/);
    expect(labelForSubtermId('bishop_pawns', 'en')).toMatch(/bad bishop/);
    expect(labelForSubtermId('outpost_knight', 'ru')).toBe('конь на форпосте');
    expect(labelForSubtermId('outpost_knight', 'en')).toBe(
      'knight on an outpost',
    );
  });

  it('возвращает null для неизвестного ID', () => {
    expect(labelForSubtermId('does_not_exist', 'ru')).toBeNull();
    expect(labelForSubtermId('does_not_exist', 'en')).toBeNull();
    expect(labelForSubtermId('', 'ru')).toBeNull();
  });
});
