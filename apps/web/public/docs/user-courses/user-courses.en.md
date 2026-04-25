# "My courses" — user guide

This section of the site lets you create your own chess courses and take
courses made by other users. A course is built from lessons, and a lesson
is built from steps of three kinds: theory, puzzle, and an endgame drill
against the engine.

This document walks you through it step by step: what you see on the main
page, how to create a course, how to take one, what counts towards your
ratings, and what limitations exist today.

## Contents

1. [What "My courses" is](#1-what-my-courses-is)
2. [The "Lessons" page](#2-the-lessons-page)
3. [Creating your own course](#3-creating-your-own-course)
4. [Taking a course](#4-taking-a-course)
5. [What the author sees: course statistics](#5-what-the-author-sees-course-statistics)
6. [Points and rating](#6-points-and-rating)
7. [Known limitations](#7-known-limitations)

---

## 1. What "My courses" is

"My courses" is the section for user-made courses. Any signed-in user
can put together their own course and share it via a link. Unlike the
system level courses (Beginner / Intermediate / Advanced), which are
filled in by the site team, user courses are created by the users
themselves.

A course consists of lessons. A lesson consists of steps. Three step
types are supported:

- **Theory** — formatted text with images and chess diagrams.
- **Puzzle** — a set of chess puzzles from the puzzle database. To
  finish the step, you need to solve the required number of puzzles.
- **Endgame drill** — a position where you play against the Stockfish
  engine and need to reach a certain result (deliver mate, win
  material).

A course can be **public** (then anyone with the link can take it) or
**private** (only you, the author, can see it).

---

## 2. The "Lessons" page

The section is at `/lessons`. What you see there depends on whether
you are signed in, whether you have your own courses, and whether you
are taking any courses by other authors.

### If you don't have any courses and aren't taking any

The page shows the **"My courses"** block with a prompt to create
your first course, and the system level courses below it.

![Lessons page: a user with no courses of their own and no courses in progress](./screenshots/student-lessons-no-enrollment.png)

To create a course — click **"+ Create my course"**. See the
"[Creating your own course](#3-creating-your-own-course)" section for
details.

### If you have your own courses

You'll see cards for your courses, marked "Public" or "Private", with
the lesson count. On a course you've personally completed, a green
**"✓ COMPLETED"** badge appears.

![Lessons page: the "My courses" block with the author's cards](./screenshots/lessons-list-my-courses-section.png)

Below a public course's card you'll see a short stat line "N enrolled ·
M completed" — that's the number of users who opened your course and
finished it (see "[What the author sees](#5-what-the-author-sees-course-statistics)").

![Lessons page: a card with the "Completed" badge and a counter of finishers](./screenshots/lessons-list-stats-and-passed.png)

### If you are taking other authors' courses

A separate **"Courses I'm taking"** block appears — it lists public
courses by other authors that you've already started. A course shows up
in this block automatically once you open it via a link and complete at
least one step.

![Lessons page: the "Courses I'm taking" block (desktop)](./screenshots/enrolled-block-desktop.png)

The same block on mobile:

![Lessons page: the "Courses I'm taking" block (mobile)](./screenshots/enrolled-block-mobile.png)

### Full page view for an author

For an author with several courses and active progress in others'
courses, the page combines both blocks:

![Lessons page: full view for an author with several courses](./screenshots/lessons-list-author.png)

On mobile:

![Lessons page: the page on mobile](./screenshots/lessons-list-mobile.png)

---

## 3. Creating your own course

### Step 1. Click "+ Create my course"

The button is in the "My courses" block on the `/lessons` page. After
the click, a draft course with an empty title is created automatically,
and you're taken to the editor.

### Step 2. The course editor

On the left — the list of lessons in the course (empty for now); on the
right — the editor for the selected lesson. At the top — the course
title (you can rename it right here), the Public/Private toggle, and
the actions menu.

![Course editor: overview](./screenshots/editor-overview.png)

### Step 3. Title and description

Click the title at the top — an edit field appears. Pick a meaningful
title (1 to 120 characters) and, optionally, a short description below
it. Changes are saved automatically after a brief pause in typing.

### Step 4. Public or private

The toggle near the top of the editor:

- **Private** (the default). Only you can see the course. Nobody else
  can open it, even if they know the link.
- **Public**. Any signed-in user who has the link can open the course
  and take it.

![Editor: the publish toggle on a private course](./screenshots/editor-private-publish-toggle.png)

> The site currently has no catalog of public courses. That means: even
> if you flip your course to public, outsiders won't find it on their
> own. To get someone to take your course, send the link to them
> directly (see "[Known limitations](#7-known-limitations)").

### Step 5. Add the first lesson

The "+ Add lesson" button in the left column creates an empty lesson.
Once created, it appears in the list and opens for editing on the
right. A lesson has its own title and an optional "estimated time"
field (in minutes).

### Step 6. Add steps to the lesson

Inside the lesson — the "+ Add step" button. When you click it, a
type picker opens:

![Editor: choosing the step type](./screenshots/editor-step-type-picker.png)

Three types to choose from:

#### 6a. Theory

A text step with markdown support. Above the editing field there's a
formatting toolbar: headings, bold text, lists, links, diagram insert.

![Editor: a text step with the formatting toolbar](./screenshots/editor-text-step-toolbar.png)

To insert a chess diagram, click the piece button on the toolbar or
type the placeholder `{{diagram:0}}` and fill in the diagram data
(FEN, board orientation — White or Black at the bottom — and a
caption).

For the diagram, you can either type a FEN by hand or build the
position visually with the **board editor**. Open the "Set Position"
modal and pick the "Board Editor" tab:

![Editor: the "Set Position" modal with a visual board editor](./screenshots/editor-board-modal.png)

A single text step can hold up to 20 diagrams. The text itself — up to
10,000 characters.

#### 6b. Puzzle

A step with a set of chess puzzles. The set can be defined in two ways:

- **By filter** — you set themes (for example "mateIn1", "pin",
  "middlegame"), a rating range, and a maximum number of puzzles
  (1–20). The site picks the puzzles itself from the puzzle database.

  ![Editor: a puzzle step with a theme filter](./screenshots/editor-puzzle-step.png)

- **By list** — you provide explicit puzzle IDs from the database
  (rarely used, mostly for hand-picked teaching sets).

#### 6c. Endgame drill

A step where the student plays a position against the Stockfish engine.
The editor lets you set:

- **FEN** — the starting position.
- **Student's side** — White or Black.
- **Engine level** — from 0 to 20 (0 — weakest, 20 — strongest).
- **Win condition** — checkmate, material gain, or evaluation
  advantage.
- **Move limit** and whether hints are allowed.

![Editor: an endgame drill step with position and engine settings](./screenshots/editor-endgame-drill-step.png)

### Step 7. Reorder and delete

- Lessons can be reordered by dragging in the left column.
- Steps inside a lesson — by dragging in the right column.
- To delete a lesson or a step — use the button in its menu.

Limits: up to 30 lessons in a course, up to 50 steps in a single
lesson.

### Step 8. Publish

When the course is ready — flip the Public/Private toggle to "Public".
Then copy the course link from the browser address bar (it looks like
`…/lessons/my/<id>`) and share it.

### If you want to delete the whole course

In the course actions menu pick "Delete course". A confirmation
dialog opens — type the word `DELETE` in the field to confirm:

![Editor: the delete-course confirmation dialog](./screenshots/editor-delete-course-dialog.png)

Deletion is final. Restoring the course or its students' progress
isn't possible.

> **If your course already has students, and you add a new lesson to
> it:** the "Course completed" mark on those students is automatically
> removed. They'll see their progress as "in progress" again until they
> complete the new lesson. This is intentional — we don't want to
> show "Completed" to a person who hasn't seen the whole course.

---

## 4. Taking a course

### Where to get the link

Right now the only way to find someone else's course is **a direct link
from the author**. The site has no catalog of public courses, no
search across courses by other authors, no "newest courses" feed. The
author has to send you the link themselves (in a messenger, by email,
anywhere).

When you open the link for the first time, the course page shows the
title, the description, and the lesson list, with no progress marks:

![Student: opening someone's public course for the first time](./screenshots/student-fresh-course-view.png)

### Open a lesson

Click the title of the first lesson. The lesson page opens, with
"0/N (0%)" progress and a list of steps. Each step has a grey "not
done" circle on the left. Steps can be taken in order or in any order
you like.

![Lesson: first time opening, no steps are done](./screenshots/student-lesson-initial.png)

### What the step icons mean

- **Grey circle** — the step isn't done yet.
- **Green circle and a green left border** — the step is done.
- **"Done ✓" label** — appears on a finished step in place of the
  "Next" button.

### How a step is marked as done

#### Theory

A text step is automatically marked done 1.5 seconds after it appears
on screen (i.e. you've had time to see it). No extra confirmation is
needed. The "Next" button below the step simply scrolls to the next
one.

![Lesson: the first step is marked done after clicking "Next"](./screenshots/student-lesson-step-done.png)

In a lesson made of several theory steps, the last step is marked
done automatically — there's no separate "Next" button under it,
but after a short pause all the steps turn green:

![Lesson: all theory steps are marked done automatically](./screenshots/student-lesson-auto-mark.png)

#### Puzzle

A chess board with the puzzle's position opens. Make the right move
(or the right sequence of moves to the end of the line) — the puzzle
counts. If you make a wrong move, the position is marked "incorrect"
and you're offered the next puzzle in the set. The step is finished
when you've solved the required number of puzzles from the set (by
default — all of them).

![Lesson: a puzzle step is open, the student needs to make a move](./screenshots/student-puzzle-solving.png)

#### Endgame drill

A board against Stockfish opens. Make a move — the engine replies. The
goal is to satisfy the win condition the author chose (deliver mate,
win material, etc.). When the condition is met, the step is marked
done automatically. If you want to start over, there's a "Resign"
button in the side panel.

![Lesson: an endgame drill step is open, the student plays against the engine](./screenshots/student-endgame-drill.png)

### When the "Complete lesson" button becomes active

The button below the lesson becomes active once you've finished **at
least 70%** of the steps. So in a 3-step lesson — after 3 steps
(≈100%); in a 4-step lesson — after 3 (75%). You can complete a
lesson without reaching 100% if one or two steps were tough.

![Lesson: all steps are done, the "Complete lesson" button is active](./screenshots/student-lesson-ready-to-complete.png)

After clicking, the lesson is marked complete. Step progress is saved
on the server — if you come back to this lesson later (close the
tab, sign in from a different device), all the previously done steps
will already show green:

![Lesson: opening it again — progress is restored](./screenshots/student-lesson-revisit.png)

### What happens after you complete the course

When you finish all the lessons in the course, a banner shows up on
the course page: **"✓ Course completed _<date>_"**:

![Course: the "Course completed" banner after finishing all lessons](./screenshots/student-course-passed-banner.png)

If the author then adds a new lesson to the course, the banner
disappears — the course goes back to "in progress" for you until you
complete the new lesson:

![Course: the banner is gone after the author added a new lesson](./screenshots/student-course-after-addlesson.png)

### A lesson with no steps

Sometimes an author may create a lesson but not fill it in yet. In
such a lesson, instead of the step list, you'll see a message saying
the lesson is still empty:

![Lesson: the author hasn't added any steps — the lesson is empty](./screenshots/student-empty-lesson.png)

Wait for the author to add content, or just move on to the next
lesson.

---

## 5. What the author sees: course statistics

When you visit your own public course, a **"Statistics"** block
appears on the course page with three numbers:

![Author: the course page with the statistics block](./screenshots/owner-course-stats.png)

- **Enrolled** — how many distinct users have made at least one step
  in your course.
- **Completed** — how many of them reached the end.
- **In progress** — how many started but haven't finished yet.

These stats are visible **only to you, the author**. Students opening
your course don't see them. Names and profiles of the students
aren't shown — only the aggregate numbers.

The same stats appear in compact form on the course card in the "My
courses" block on the `/lessons` page — as the line "N enrolled · M
completed" (see the screenshot in section 2).

---

## 6. Points and rating

What is awarded for taking a user course:

- **If a lesson contains puzzle steps**, your attempts at solving
  those puzzles count towards your overall tactics rating (the same
  puzzle rating that changes on the `/puzzle` page). Solve correctly
  on the first try — the rating goes up; fail — it goes down. This
  works exactly the same way as solving puzzles outside of a course.

What is **not** awarded:

- Completing the course as such gives **no separate score**. The
  "completed" status is simply marked with a green tick in your course
  list and a "Course completed" banner on the course page — nothing
  else.
- Theory and endgame-drill steps **don't affect** any rating. The
  games in endgame drills are played against the engine locally; they
  aren't counted as regular games and don't change your Bullet /
  Blitz / Rapid / Classical ratings.
- **Taking user courses doesn't unlock** the next level of system
  courses (Beginner / Intermediate / Advanced). Those levels open
  only by completing system courses — those are two separate
  systems.

In short: **only your tactics rating moves — and only via puzzle
steps, the same way as solving puzzles regularly**.

---

## 7. Known limitations

### No catalog of public courses

The most noticeable limitation. There is currently no page on the site
that lists all public user courses, no search across other authors'
courses, and no "newest courses" feed. The "My courses" block on the
main page shows **only your own** courses; the "Courses I'm taking"
block shows **only those by others** that you've already started.

This means:

- If you want to take someone else's course — ask the author for the
  link.
- If you've made your course public and you want others to take it —
  send the link directly (in a messenger, on social media, by email).
  Flipping a course to "public" by itself doesn't make it findable.

After you open someone's course via the link and complete at least
one step in it, the course will show up in the "Courses I'm taking"
block on the main page, and you won't have to follow the link again.

### Only 3 step types

Inside user courses, only three step types are supported: theory,
puzzle, and endgame drill. Video lessons, game reviews, and opening
trainers can't be created in user courses yet — those exist only in
the site's system courses.

### Courses are not translated

The title and the text of a user course are stored in whatever language
the author wrote them in. The site doesn't auto-translate them. If
you write a course in English, a Russian-speaking user will see the
English text as-is.

### You cannot fork someone else's course

There's currently no way to "fork" a public course made by another
author so as to make your own version. You can only take it as a
student.

---

## Appendix: what the screenshots show

The screenshots in this document use the demo courses on the site:

- **Demo public course** — a public course with two lessons (one is
  pure theory, the other has theory + a puzzle + an endgame drill).
- **Demo private course** — a private course with one lesson.

All the screenshots live in the `screenshots/user-courses/` folder
next to this document.
