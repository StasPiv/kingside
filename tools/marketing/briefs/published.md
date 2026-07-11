# Реестр публикаций (мониторинг реплаев)

Аккаунт Reddit: u/Stas-Pivovartsev (https://www.reddit.com/user/Stas-Pivovartsev/)

Проверка реплаев, каждый цикл мониторинга:
1. `node tools/reddit-read.mjs user Stas-Pivovartsev` — список опубликованных комментариев (сверка реестра, score, прямые ссылки).
2. Треды со статусом «опубликовано» за последние 3 дня: `node tools/reddit-read.mjs <url>` — поиск реплаев на комментарии u/Stas-Pivovartsev.

| Дата брифа | Тред | Статус |
|---|---|---|
| 2026-07-11 | https://www.reddit.com/r/chessbeginners/comments/1utch0q/ («950 elo») | ожидает публикации |
| 2026-07-11 | https://www.reddit.com/r/chess/comments/1ut2wk3/ («commit my time this fall») | ожидает публикации |
| 2026-07-11 | https://www.reddit.com/r/TournamentChess/comments/1ut2pw6/ («QGD exchange model games») | ожидает публикации |
| 2026-07-11 | https://old.reddit.com/r/chess/comments/1usrtrq/ («WSCC Divya 14–1», срочное 12:00) | опубликовано (owv8yxb, score 1, реплаев нет) |
| 2026-07-11 | https://old.reddit.com/r/chess/comments/1utk3vf/ («Platinum stats», срочное 15:07, упоминание kingside.site без URL) | опубликовано (owwehyq, score 1, виден без логина — фильтр прошёл, ответов нет) |

Статусы: ожидает публикации → опубликовано (после подтверждения пользователя) → закрыт (3 дня без новых реплаев).
