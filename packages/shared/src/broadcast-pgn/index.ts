/**
 * KS-4855 / ADR-159 §7 п.1. Общий пакет разбора PGN broadcast-трансляций
 * Lichess — используется backend'ом (broadcast-service) для poll-цикла и
 * (в будущем) клиентом для прямого чтения SSE-стрима с Lichess.
 */
export * from './pgn-parser.js';
