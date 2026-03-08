# QA Re-verification Report: KS-252, KS-253, KS-254

Date: 2026-03-08
Verified on: main branch (commit e8a4e51)

## KS-252 [HIGH] — Роутинг /puzzle-rush/leaderboard не работает при прямом переходе

**Fix:** Вложенные Route заменены на плоские маршруты (commit 026fa06).

**Verification:**
- App.tsx line 44-45: маршруты `/puzzle-rush` и `/puzzle-rush/leaderboard` объявлены как отдельные плоские Route
- Unit-тест `renders /puzzle-rush/leaderboard without auth (no redirect)` — PASS
- Все 10 routing-тестов в App.test.tsx — PASS

**Status: VERIFIED**

## KS-253 [LOW] — Ссылка на лидерборд не отображается на стартовой странице Puzzle Rush

**Fix:** Не требовался — ссылка была в коде, но не рендерилась из-за бага роутинга KS-252.

**Verification:**
- PuzzleRushPage.tsx line 268: `<Link to="/puzzle-rush/leaderboard" className="rush-leaderboard-link">` — присутствует на стартовом экране
- PuzzleRushPage.tsx line 304: аналогичная ссылка на экране результатов
- styles.css line 1223: стили `.rush-leaderboard-link` определены
- После фикса KS-252 роутинг работает → компонент рендерится → ссылка видна

**Status: VERIFIED**

## KS-254 [LOW] — Мобильная вёрстка Puzzle Rush: горизонтальный оверфлоу и наложение текста

**Fix:** CSS-исправления в styles.css (commits d8b3986, 6b547ea).

**Verification:**
- `body { overflow-x: hidden }` — добавлено (line 14)
- `.header nav { flex-wrap: wrap; gap: 8px }` — добавлено для предотвращения наложения текста
- `@media (max-width: 480px)` — добавлены стили для `.header nav a`, `.nav-links`, `.puzzle-rush-page .board-container`, `.puzzle-board-placeholder`
- `@media (max-width: 768px)` — добавлены стили для `.header nav`, `.nav-links`, `.logo`
- Доска: `max-width: 100%; aspect-ratio: 1` — ограничивает ширину viewport

**Status: VERIFIED**

## Summary

| Ticket | Severity | Status |
|--------|----------|--------|
| KS-252 | HIGH | VERIFIED |
| KS-253 | LOW | VERIFIED |
| KS-254 | LOW | VERIFIED |

All unit tests pass (10/10).
