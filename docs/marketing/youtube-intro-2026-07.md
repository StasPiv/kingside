# Kingside — YouTube intro video (EN, 3–4 min)

Date: 2026-07-09 (revised: accents shifted off competitor comparison onto founder story + product)
Owner: marketing (KS-4865)
Format: talking-head + short screen inserts of the site.
Language: English.

---

## 0. What this file is

Full spoken script for a 3–4 minute YouTube video introducing the founder of Kingside (Stanislav Pivovartsev) and the product itself. The video's job is to convert a first-time viewer — most likely a club-level chess player — into someone who opens `kingside.site` in a new tab.

At the bottom of the file there is a 60-second cut-down for Shorts / Reels / TikTok.

## 1. Positioning summary (why the script says what it says)

- **The hook is the person.** One human who is both a strong club player *and* a senior engineer, building a chess site in the open. That is the reason a viewer keeps watching past second 5 — not a feature.
- **Lead with the product, shown on screen.** Three things a viewer can watch happen in the product: puzzles built from your own games, a full engine and bot play that run in your browser, and a set of training modes. Each is demonstrated on camera, not argued about.
- **"Free, no ads" is stated as a fact about Kingside** — not as an attack on other sites. No ranking, no "chess.com hides this", no "Lichess lacks that". Comparison stays as a single light background line, without a list and without claims we can't stand behind.
- **AI-generated commentary is NOT featured.** Per founder's decision (2026-07-09): the feature is partial. Not in the script — main version or Shorts. Analysis is described as "Stockfish analysis and workshop tools", full stop.
- **Tone: expert, slightly self-deprecating, no marketing gloss.** Short sentences. Real numbers. No "revolutionary", no "empower", no "journey".
- **Assumed default audience** (until coordinator confirms otherwise): rated club players 1500–2000 looking for training tools; secondary layer — developers curious what a solo-built modern chess site looks like under the hood. The stack mention serves the second group without slowing the first.

## 2. What the video shows (from the product)

Based on the state of `apps/web/src/pages/` and `apps/web/src/i18n/locales/en/translation.json` on 2026-07-09. These are shown, not compared.

### 2.1 Puzzles generated from the user's own PGN — free, no signup
- Public landing at `/puzzles-from-your-games` (source: `PuzzlesFromYourGamesPage.tsx`). SEO copy: *"Upload a PGN — Kingside turns your blunders into tactical puzzles."*

### 2.2 Local Stockfish 18 in the browser + bot play with no signup, no ads
- Stockfish 18 WASM runs client-side (see `apps/web/public/stockfish`). The engine analyses on the user's own CPU — nothing is shipped to the server for engine work. The i18n string for `/play/local-bot`: *"Stockfish 18 runs locally — your game never leaves the device."*

### 2.3 A visualisation and calculation training toolkit
- **Blindfold trainer** (`/blind-board`) — recall positions from move-arrows, with structured levels and streak tracking.
- **Guess the move** (`/guess`) — predict grandmaster moves in real games, with per-move engine feedback.
- **Precision training** (`/precision`) — hold your advantage against a full-strength Stockfish for N half-moves.
- **Drills** (`/drills`) — openings and endgames with sprint mode and leaderboard.

Everything else on the platform (rated play, tournaments, live broadcasts, coach profiles, courses, archive, opening trainer, Stockfish analysis workshop) is mentioned in one line during the "what the project is" block.

---

## 3. Full 3–4 minute script (English, spoken)

Legend: `[cut to X]` = suggested visual insert. Speaker delivers everything else to camera.

### 0:00 – 0:15 — Hook

> I'm a Candidate Master. I also happen to be a senior backend engineer. Two lives that don't usually meet in the same person — so I built a chess site where they do. It's called Kingside, it's free, and I want to show you what's in it.

`[cut to] fast montage: FIDE profile card → GitHub repo count → Kingside homepage`

### 0:15 – 0:45 — Who I am

> Real quick: I'm Stanislav. I live in Prague. My day job is writing PHP and TypeScript at scale — the kind of work where a wrong index costs you a weekend. My other life is chess. FIDE rating around 2100 across standard, rapid, and blitz. I'm not a Grandmaster and I'm not selling you a course. I'm the guy who plays the tournament on Saturday and ships the code fix on Sunday.

`[cut to] a photo, then a screenshot of a recent OTB tournament pairing sheet or game archive`

### 0:45 – 1:15 — Why I built it

> I've spent years training on other sites, and at some point I wanted a place built exactly the way a playing engineer would build it: everything free, no ads, and training tools chosen because they actually move a club player's rating — not because they drive engagement. So instead of complaining, I wrote it. Nights and weekends. One person, in the open. This is what came out.

### 1:15 – 1:35 — What Kingside is

> Kingside is a full online chess platform. Play bullet, blitz, rapid, classical — rated or casual, humans or bots. Puzzles, tournaments, live broadcasts of over-the-board events, a Stockfish analysis workshop, a game archive, coach profiles, structured courses. That's the base. Let me show you the three parts I'm most proud of.

`[cut to] 4-second scroll through the /features page`

### 1:35 – 2:10 — Part one: Puzzles from your own games

> **One.** Upload a PGN — even an export from another site — and Kingside finds your blunders and turns each one into a tactical puzzle. You train on the exact positions where you actually go wrong, not on random puzzles from a database. If you keep losing the same middlegame twice a week, this is the feature that fixes it. It's on the homepage. No signup required.

`[cut to] the /puzzles-from-your-games flow: drag-and-drop, then a solved puzzle from a real user game`

### 2:10 – 2:40 — Part two: The engine runs in your browser

> **Two.** Stockfish 18 runs in your browser as WebAssembly. Not on our server — on your CPU. Which means two things. First: your positions and your games never leave your device for engine analysis. Second: you can open the site right now, without an account, and play a full match against the engine at any of twenty-plus skill levels. Just a board, a clock, and the strongest open-source engine on the planet.

`[cut to] /play/local-bot: level picker, then a mid-game screenshot with engine turn indicator`

### 2:40 – 3:10 — Part three: Visualisation and calculation training

> **Three.** A training toolkit built for actual improvement. Blindfold trainer — you don't see the board, only the moves. Guess-the-move — play through a real master game and try to predict every move before it's shown. Precision drills — you get a winning position and you have to hold it against a full-strength Stockfish for fifteen moves in a row. Openings and endgame drills with a sprint mode and a leaderboard. Four modes, one place, free.

`[cut to] four quick 2-second shots: blindfold arrow overlay → guess-the-move verdict → precision timer → drill sprint results`

### 3:10 – 3:30 — Stack (for the engineers in the room)

> For anyone curious how this is built: TypeScript monorepo. React 19 on the front, NestJS on the back, PostgreSQL with Prisma, WebSocket for the live game and clock, Stockfish 18 WASM in the browser. Everything I ship goes straight to main — no feature branches, no ceremony. One person, one codebase, one deployment pipeline.

`[cut to] the GitHub org page or a screenshot of the monorepo tree`

### 3:30 – 3:50 — Invitation

> So — if you're a club player looking for tools that actually push your rating, or you just want to see what one engineer with a chess habit can build — go to kingside dot site. It's free. It'll stay free. And if you break something, tell me — I'm the entire support team. See you on the board.

`[cut to] URL card: kingside.site, sub-caption "One dev. FIDE 2100. No ads." — hold 3 seconds`

---

## 4. Delivery notes

- **Word count:** ~500 words spoken. At natural pace (135–140 wpm) this is ~3:40. Room to breathe.
- **Where to slow down:** the three "One / Two / Three" openings, and the URL at the end. Everywhere else, keep pace.
- **Where to cut if too long:** the middle of "Why I built it" is the safest 5–6-second cut. Second-safest: the "twenty-plus skill levels" clause in part two.
- **What NOT to say on camera:** "revolutionary", "the best", "we", "our team", "gamified", "AI", "AI-powered", "smart", "next-gen". No "AI on every move" claim anywhere. No ranking of chess.com / Lichess by feature — the video shows Kingside, it does not rate competitors.
- **Numbers to double-check before recording:** FIDE ratings (Standard 2035 / Rapid 2144 / Blitz 2138 — script says "around 2100" which averages cleanly), Stockfish version deployed (script says 18, matches `apps/web/public/stockfish` and CLAUDE.md), number of bot skill levels (script says "twenty-plus" — verify against `LocalBotGamePage.tsx` before shoot).

---

## 5. 60-second Shorts / Reels / TikTok cut

Vertical 9:16, punchier delivery.

### 0:00 – 0:08 — Hook

> I'm a FIDE 2100 chess player and a senior software engineer. Two lives that don't usually meet — so I built a chess site where they do.

### 0:08 – 0:22 — Proof

> It's called Kingside. React on the front, NestJS on the back, Stockfish 18 running locally in your browser. Free, no ads, shipped by one person.

### 0:22 – 0:50 — Three parts

> Three parts I built it around.
> **One** — upload your PGN and it turns your own blunders into training puzzles. Free.
> **Two** — Stockfish 18 in your browser, no signup, twenty-plus bot levels ready in one click.
> **Three** — a full training toolkit: blindfold, guess-the-move, precision drills, opening and endgame sprints. All in one place.

### 0:50 – 1:00 — CTA

> Kingside dot site. No ads, no subscription, made by someone who plays. Link in bio.

---

## 6. Post-production checklist

- [ ] On-screen captions for the three parts (accessibility + silent autoplay on mobile feeds).
- [ ] End card: `kingside.site` URL + "Made by @StasPiv" — hold 3 s.
- [ ] YouTube description: paste section 3 timestamps as chapter markers.
- [ ] Pin a top comment linking directly to `/puzzles-from-your-games`.
- [ ] Video SEO title candidates: *"I'm a Candidate Master, so I built my own chess site — here's what's in it"* / *"A free chess site with no ads — built by one engineer"*.
- [ ] Thumbnail: split — left half founder photo, right half a puzzle diagram with a red arrow labelled *"Your blunder → your puzzle"*.
