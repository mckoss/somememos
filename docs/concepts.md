# Concepts

This page explains the ideas behind somememos, briefly and with examples. The design record, with the reasons for each decision, is [PLAN.md](../PLAN.md); this page describes what the software does today (version 0.5.0).

## A brain is a folder of markdown

A **brain** is a folder of ordinary markdown files. Notes link to each other with `[[wiki-links]]`, such as `[[compost-tea]]` or `[[compost-tea#Recipe|the recipe]]`. somememos never rewrites a note on its own: the text you write is stored byte for byte, and any editor can read and change the files.

Beside the notes, somememos keeps a small amount of data of its own. In a local folder this lives in `.somememos/`:

```
garden/
  memos/compost-tea.md
  diary/2026/11/2026-11-27.md
  .somememos/
    config.json     folder roles, half-lives, weights (can be committed to git)
    events.sqlite   the event log: original data, keep a backup
    index.sqlite    keyword index and scores: derived, safe to delete
```

The web app keeps the same data inside the browser, and the server keeps it in Postgres plus a git repository per brain.

## Folder roles

A brain's config maps **roles** to folders or path patterns. A file takes the first role that matches, and `excluded` is always checked first.

| Role | Typical folder | What it means |
|---|---|---|
| `memo` | `memos/` | A lasting note. Scored, searchable, and the only kind (with blog posts) that appears in the hot, trending and neglected lists. |
| `dated` | `diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md` | One entry per day. The date comes from the path. Searchable, and its links count as mentions of the notes they point to, but it is not scored itself. |
| `source` | `sources/` | Material kept as it is. Searchable; the CLI and server refuse to save a changed source, and the web app won't edit one. |
| `blog` | `blog/{YYYY}/{YYYY}-{MM}-{DD}-*.md` and `blog/` | A post you can publish. Scored like a memo, with its date from the path. Private until its front matter says `published: true`. |
| `excluded` | for example `private/` | Never read, indexed, logged or shown. Use it for private folders. |

Patterns: `memos/` means everything in that folder, `*` matches within one name, `**` matches any number of folders, and `{YYYY}`, `{MM}`, `{DD}` mark the date in a dated pattern. A brain that declares no roles at all treats every markdown file as a memo. When roles are declared, a file that matches none of them is left out.

A lasting note is called a **memo**, in keeping with the name. Elsewhere in these docs, "note" means any markdown file in a brain.

## Events: read, edit, mention

Every interaction with a scored note is recorded as an **event** with a unique id, the note, the kind, the time and the client that recorded it.

| Kind | When it is recorded |
|---|---|
| `read` | The note is read through somememos: `somememos read`, opening it in the web app, or the server's note route. |
| `edit` | The note's content changes: a commit in the CLI, a save in the app, a save through the server. Dated at the file's modification time, never in the future. |
| `mention` | An edit adds a `[[link]]` to the note, or to a note that doesn't exist yet. |

There is also a `rename` record, so a note's history follows it when it moves.

Some things are deliberately **not** events:

- Appearing in search results or in the hot, trending and neglected lists. Counting those would make popular notes more popular.
- Reading a file with `cat` or another tool. somememos cannot see it, which is why agents are told to use `somememos read`.
- A change that arrives through sync. The client that made the edit recorded it; the one that receives it does not record it again.
- A visit to a public blog page.
- A dated entry or a source being read. Only memos and blog posts are scored.

Search query text is never logged.

## Half-lives and scores

somememos scores notes with Mike Koss's **TimeScore** algorithm, described in full at <https://mckoss.com/posts/timescore/>. Each event is worth 1 when it happens and loses half its value every **half-life**. A note keeps one score per half-life:

| Name | Half-life | Roughly answers |
|---|---|---|
| day | 1 day | what am I doing right now? |
| week | 7 days | what is my current focus? |
| month | 30 days | what are my ongoing projects? |
| year | 365 days | what matters to me over the long run? |

So a note edited once today has a week score of 1.0; a week from now, with no more activity, its week score is 0.5. A note read yesterday and again today has a day score of about 1.5 today (1 for today's read, 0.5 for yesterday's) and a week score of about 1.9.

Two properties make this cheap. Scores are stored in a form that never needs updating as time passes, so the order of notes only changes when a new event arrives. And combining two scores is commutative and associative, so events from several devices can be merged in any order, as long as each event is counted once.

Scores are stored per event kind, without weights. The weights (all 1 today) are applied when scores are read, so changing a weight needs no rebuild.

## Hot, trending and neglected

The three lists rank memos, blog posts and dangling links by activity alone:

- **Hot** ranks by the week score: what you have been using most lately. `somememos hot` shows it as `week 2.40`, meaning the note's activity, faded, is worth 2.4 fresh events today.
- **Trending** compares the week score with the month score, among the notes with the most recent activity. It is shown as a pace: `pace 1.0x` is a note's usual rate for steady daily activity; `2.2x` means it is heating up.
- **Neglected** compares the year score with the month score, among the notes with the most activity over a year: notes that used to matter and have gone quiet. It is shown as `year 3.32 month 0.42`.

**Search** combines the two signals. Each match gets a keyword relevance score (BM25F over the title, `##` headings and body, computed by somememos itself so every client ranks identically), and the rank is `ln(relevance) + α × activation`, with α = 0.5. In effect: relevance times the square root of activation. Search has four modes: hot (the default), trending, neglected, and all (keywords only). With no keywords, a search is simply the list for its mode.

Every result can be explained: the CLI's `--json` output and the web app's "Why this rank" panel show the relevance, the score at each half-life and the split between reads, edits and mentions.

## The burst rule

Saving a note ten times in a quarter of an hour is one piece of work, not ten. Of one note's events of one kind, an event counts only if it is at least one hour after the last one that counted. The rule is applied when the event log is folded into scores, so every event is still kept in the log, and the window can be changed (`burstWindow` in the config, in seconds; 0 turns it off) by rebuilding the scores.

## Dangling links

A link to a note that doesn't exist yet, such as `[[candy-board]]` when there is no `candy-board.md`, is a **dangling link**. It is scored like a note, by the mentions it collects, so an idea you keep linking to rises in the hot list before you have written it. The CLI shows it as `(not written yet) candy-board`, and the web app lists them under "Not written yet". When you create the note, the link's history carries over to it.

Links resolve, in order, to an exact path, a path relative to the linking note, then a unique file name anywhere in the brain, ignoring case. A link to a non-markdown file, such as `![[photo.png]]`, is ignored.

## The change log

Every commit records one **change record**: the time, the client, the notes that changed, and the message given with it. Agents don't write changelog files; they give the reason as the commit message:

```sh
somememos commit -m "update add the winter check"
```

The optional first word is an operation tag (`ingest`, `update`, `session`, `query`, `lint` by default). `somememos log` shows the change log newest first, can be narrowed to one note, an operation, a date range or words in the message, and by default hides changes that touch only dated entries. On the server, each change record is also the message of that change's git commit.

## The event log is the source of truth

The event log (with the change records) is the one part of a brain that cannot be rebuilt from the markdown: nothing in the files says which notes were read. It is append-only, and every record has a unique id, so importing the same records twice adds nothing.

Everything else is derived. The keyword index is built from the markdown; the scores are folded from the event log. Both can be deleted and rebuilt at any time (`somememos index --rebuild`). A full backup of a brain is therefore the markdown plus the exported event log (`somememos export`, or "Export events.jsonl" in the web app).

## What is and isn't synced

Between the web app or a `somememos clone` copy and a server, sync sends and receives:

- notes (new versions, deletes and renames, each with the version it was based on),
- events (reads, edits, mentions and renames), and
- change records.

It never sends scores or the index: each copy computes its own from the same events and gets the same result. Also not synced:

- **Folder roles.** They are set when a brain is created on the server, and a copy takes them from there. Changing roles later on one device is not pushed anywhere.
- **The access token.** It stays on the device that holds it.
- **Unsaved drafts** in the web app's editor.
- **Blog settings**, which live only on the server.

A note changed on two devices at once is a conflict. Nothing is overwritten: the server's version keeps the path, and the other version is kept beside it as `name.conflict-<client>-<date>.md` until someone merges it.

## Set by experiment

somememos does not pick its ranking parameters by intuition. `somememos eval` replays a brain's own history: it rewinds to a past moment, folds only the events before it, and checks whether the notes that were actually used next ranked near the top. Each parameter setting gets a recall and mean reciprocal rank score, and the best measured setting becomes the default. See [the CLI guide](cli.md#evaluating-ranking-settings-eval) for how to run it.

The first run, on one real vault with about seven months of history (247 search cases and 272 orientation cases), found that activation clearly helps search (mean reciprocal rank 0.43 with keywords alone, 0.59 with activation), that activation should count less than relevance (α = 0.5), that counting a burst of edits once helps, and that spreading activation along links hurts. Those choices are the defaults in the code. The read weight is still unmeasured, because imported history contains no reads. The full table and its caveats are in [PLAN.md section 5](../PLAN.md#5-ranking-and-search).
