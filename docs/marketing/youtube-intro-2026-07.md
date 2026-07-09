# Kingside — YouTube intro video (EN, 3–4 min)

Date: 2026-07-09
Owner: marketing (KS-4865)
Format: talking-head + short screen inserts of the site.
Language: English.

---

## 0. What this file is

Full spoken script for a 3–4 minute YouTube video introducing the founder of Kingside (Stanislav Pivovartsev) and the product itself. The video's job is to convert a first-time viewer — most likely a club-level chess player who found us via a puzzle-related search — into someone who opens `kingside.site` in a new tab.

At the bottom of the file there is a 60-second cut-down for Shorts / Reels / TikTok.

## 1. Positioning summary (why the script says what it says)

- **Hook is the person, not the product.** Both chess.com and Lichess have massive marketing budgets. We do not. What we have that they do not is a face: one person who is a strong club player *and* a senior engineer, doing this in the open. That contradiction is the whole reason a viewer keeps watching past second 5.
- **Three differentiators, all concrete.** No "cleaner interface", no "better UX". Three things you can point at in the product and demonstrate on camera. Each has a paid or missing equivalent on chess.com / Lichess — the script names those explicitly.
- **Tone: expert, slightly self-deprecating, no marketing gloss.** The viewer we want is allergic to product-speak. So no "revolutionary", no "empower", no "journey". Short sentences. Real numbers.
- **Assumed default audience** (until coordinator confirms otherwise): rated club players 1500–2000 looking for training tools that actually move their rating; secondary layer — developers curious what a solo-built modern chess site looks like under the hood. Script serves both because the stack mention (0:20 in the intro block) is a hook for devs without slowing the chess audience.

## 2. Three differentiators (research)

Based on the state of `apps/web/src/pages/` and `apps/web/src/i18n/locales/en/translation.json` on 2026-07-09.

### 2.1 AI text commentary on every move — free
- Kingside surfaces plain-English explanations for each move, layered on top of Stockfish evaluations. The i18n keys `landing.usp.point1.*` describe it as *"Not just +1.5 — a text explanation of why a move is strong, where the mistake is, and what the position threatens."*
- chess.com equivalent: **Game Review** — paid feature, requires Diamond membership (~$14/month at time of writing).
- Lichess equivalent: none. Lichess offers Stockfish eval and NAG symbols only.

### 2.2 Puzzles generated from the user's own PGN — free, no signup
- Public landing at `/puzzles-from-your-games` (source: `PuzzlesFromYourGamesPage.tsx`). SEO copy is explicit: *"Upload a PGN — Kingside turns your blunders into tactical puzzles."*
- chess.com equivalent: **Insights** / personalised puzzle tracks — behind Diamond.
- Lichess equivalent: manual analysis exists, but no automated blunder-to-puzzle pipeline.

### 2.3 Local Stockfish 18 + a full training toolkit
- Stockfish 18 WASM runs client-side (see `apps/web/public/stockfish`). The engine analyses positions on the user's own CPU — nothing is shipped to the server for engine work. The i18n string for `/play/local-bot` is explicit: *"Stockfish 18 runs locally — your game never leaves the device."*
- Beyond the engine itself, four training modes exist that neither of the big two offers as first-class flows:
  - **Blindfold trainer** (`/blind-board`) — recall positions from computer move-arrows, with structured levels.
  - **Guess the move** (`/guess`) — predict grandmaster moves in real games, with per-move engine feedback.
  - **Precision training** (`/precision`) — hold your advantage against a full-strength Stockfish for N half-moves.
  - **Drills** (`/drills`) — openings and endgames.

These three are what the script uses. Everything else on the platform (rated play, tournaments, live broadcasts, coach profiles, courses, archive, opening trainer) is table stakes and gets mentioned in one line during the "what the project is" block.

---

## 3. Full 3–4 minute script (English, spoken)

Legend: `[cut to X]` = suggested visual insert. Speaker delivers everything else to camera.

### 0:00 – 0:15 — Hook

> I'm a Candidate Master. I also happen to be a senior backend engineer. So when I got tired of paying fifteen bucks a month for a chess site that felt like a slot machine — I built my own. Ninety thousand lines of code later, it's live. It's called Kingside, and here's what makes it different.

`[cut to] fast montage: FIDE profile card → GitHub repo count → Kingside homepage`

### 0:15 – 0:45 — Who I am

> Real quick: I'm Stanislav. I live in Prague. My day job is writing PHP and TypeScript at scale — the kind of work where a wrong index costs you a weekend. My other life is chess. FIDE rating around 2100 across standard, rapid, and blitz. I'm not a Grandmaster and I'm not selling you a course. I'm the guy who plays the tournament on Saturday and ships the code fix on Sunday.

`[cut to] a photo, then a screenshot of a recent OTB tournament pairing sheet or lichess/chess.com game archive`

### 0:45 – 1:15 — Why I'm doing this

> Chess.com and Lichess are great — I use both. But chess.com has turned into a subscription treadmill: the good analysis is Diamond, the good coaching is Diamond, even the good stats are Diamond. Lichess is free but its interface hasn't really moved in five years. I wanted a middle ground: everything free, no ads, and features that actually help you improve — built by someone who plays.

### 1:15 – 1:35 — What Kingside is

> Kingside is a full online chess platform. You can play bullet, blitz, rapid, classical — rated or casual, humans or bots. You get puzzles, tournaments, live broadcasts, analysis, a game archive, coach profiles, courses. The usual set — plus three things that neither of the big sites gives you for free.

`[cut to] 4-second scroll through the /features page`

### 1:35 – 2:05 — Differentiator #1: AI move commentary

> **One.** Every move gets a plain-English explanation. Not the number *plus one point five* with a green bar — actual sentences. *"This bishop was your only defender of f7 — trading it opens a mating net in three."* The AI runs on top of Stockfish evaluations, so it's grounded, not hallucinated. On chess.com the same thing is called Game Review and it costs fifteen dollars a month. Here it's free.

`[cut to] a real game review screen with the AI comment visible next to the move`

### 2:05 – 2:35 — Differentiator #2: Puzzles from your own games

> **Two.** Upload a PGN — even a Lichess or chess.com export — and Kingside finds your blunders and turns each one into a tactical puzzle. You train on the exact positions where you actually go wrong, not on random Lichess database problems. Chess.com hides this behind Diamond. Lichess doesn't have it at all. On Kingside it's on the homepage, no signup required.

`[cut to] the /puzzles-from-your-games flow: drag-and-drop, then a solved puzzle from a real user game`

### 2:35 – 3:05 — Differentiator #3: Local engine + training toolkit

> **Three.** Stockfish 18 runs in your browser as WebAssembly. Your position never gets shipped to a server for analysis — it just runs on your CPU. And around that engine there's a full training toolkit: blindfold trainer, guess-the-move on real master games, precision drills where you have to hold your advantage against a full-strength Stockfish for fifteen moves in a row. Most of that is either paid or nonexistent elsewhere.

`[cut to] three quick 2-second shots: blindfold arrow overlay → guess-the-move verdict → precision timer`

### 3:05 – 3:25 — Stack (for the engineers in the room)

> For anyone curious: it's a TypeScript monorepo. React 19 on the front, NestJS on the back, PostgreSQL with Prisma, WebSocket for the live game and clock. Stockfish 18 WASM in the browser. Everything I ship goes straight to main — no feature branches, no ceremony. One person, one codebase, one deployment pipeline.

`[cut to] the GitHub org page or a screenshot of the monorepo tree`

### 3:25 – 3:45 — Invitation

> So — if you're a club player looking for tools that actually push your rating, if you're tired of the paywalls, or if you just want to see what one engineer with a chess habit can build — go to kingside dot site. It's free. It'll stay free. And if you break something, tell me — I'm the entire support team. See you on the board.

`[cut to] URL card: kingside.site, sub-caption "One dev. FIDE 2100. No ads." — hold 3 seconds`

---

## 4. Delivery notes

- **Word count:** ~500 words spoken. At natural pace (135–140 wpm for a technical accent-inflected English) this is 3:35–3:45. Room to breathe.
- **Where to slow down:** the three "One / Two / Three" openings, and the URL at the end. Everywhere else, keep pace — the script is deliberately dense.
- **Where to cut if too long:** the last sentence of "Why I'm doing this" (1:10–1:15) is the safest 5-second cut.
- **What NOT to say on camera:** "revolutionary", "the best", "we", "our team", "gamified", "AI-powered" (the word "AI" is used exactly once, deliberately, in differentiator #1). Everything else undermines the core positioning: one honest person.
- **Numbers to double-check before recording:** FIDE ratings (Standard 2035 / Rapid 2144 / Blitz 2138 — the script says "around 2100" which averages cleanly), GitHub repo count (64 as of 2026-07-09), chess.com Diamond price (script says $15, verify at record time), Stockfish version currently deployed (script says 18, matches `apps/web/public/stockfish` and CLAUDE.md).

---

## 5. 60-second Shorts / Reels / TikTok cut

Vertical 9:16, punchier delivery.

### 0:00 – 0:08 — Hook

> I'm a FIDE 2100 chess player and a senior software engineer. I got tired of chess sites charging fifteen bucks a month for basic analysis. So I built my own.

### 0:08 – 0:22 — Proof

> It's called Kingside. React on the front, NestJS on the back, Stockfish 18 running locally in your browser. Ninety thousand lines. Shipped by one person.

### 0:22 – 0:50 — Three hooks

> Three things it does that chess.com and Lichess don't.
> **One** — every move you play gets a plain-English explanation, not just a number.
> **Two** — upload your PGN and it turns your own blunders into training puzzles.
> **Three** — a full toolkit: blindfold trainer, guess-the-move, precision drills against Stockfish. All free.

### 0:50 – 1:00 — CTA

> Kingside dot site. Zero ads, zero subscription, made by someone who plays. Link in bio.

---

## 6. Post-production checklist

- [ ] On-screen captions for the three differentiators (accessibility + silent autoplay on mobile feeds).
- [ ] End card: `kingside.site` URL + "Made by @StasPiv" — hold 3 s.
- [ ] YouTube description: paste sections 3.1–3.7 as timestamps for chapter markers.
- [ ] Pin a top comment linking directly to `/puzzles-from-your-games` (highest-converting entry point per landing SEO priorities in `sitemap.xml`).
- [ ] Video SEO title candidates: *"I'm a Candidate Master, so I built my own chess site — here's why"* / *"Kingside — the free chess site with AI move explanations"*.
- [ ] Thumbnail: split — left half founder photo, right half a mate-in-3 diagram with a red arrow labelled "AI: 'This trades your only defender of f7'".
