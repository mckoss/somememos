# The somememos command-line tool

`somememos` is the command-line tool for a brain. It is how AI agents use one, and it works just as well by hand. It runs in two modes with the same commands and the same flow (search, read, edit, commit):

- **Local mode:** the brain is a folder on this machine. Everything runs offline.
- **Remote mode:** the brain is on a somememos server. Each command is a request to the server, and a small working folder holds only the notes you have read.

This guide covers installing, both modes, every command, and the ranking experiments. For the ideas behind the commands (roles, events, half-lives), see [concepts.md](concepts.md). For setting up an AI agent, see [agents.md](agents.md).

The examples below were run on an invented example brain. You can make the same one and follow along (see [An example brain](#an-example-brain)). Long absolute paths in the output are shortened to `~/garden`, and your scores and dates will differ a little, because the example ends on the day before you make it.

## Installing

somememos needs **Node 22.13 or later**. It has no other dependencies: it uses Node's built-in SQLite.

**From a clone (today's way).**

```sh
git clone https://github.com/mckoss/somememos.git
cd somememos
npm ci
npm run build
npx somememos --version          # 0.5.0
```

`npx somememos` works from inside the checkout. To run it from anywhere, link the binary onto your `PATH`, for example `ln -s "$PWD/packages/cli/bin/somememos.js" ~/.local/bin/somememos`.

**As one file.** The CLI can be bundled into a single JavaScript file that needs only Node, which is handy for a cloud session or another machine:

```sh
npm run bundle -w @somememos/cli    # writes packages/cli/bundle/somememos.mjs (about 450 KB)
node packages/cli/bundle/somememos.mjs --version
```

Copy that file anywhere, make it executable, and run it as `somememos`.

**A release download is not published yet.** `somememos help setup` prints an install line with the placeholder `<SOMEMEMOS-RELEASE-URL>`; until there is a release, build the bundle yourself as above.

Node 22 prints an "experimental" warning when it loads SQLite; the CLI hides it.

## Local mode

### A new brain

```sh
mkdir ~/garden && cd ~/garden
somememos init
```

In an empty folder, `init` creates `memos/`, `diary/`, `sources/` and `blog/`, declares them as the memo, dated, source and blog roles, and takes the first index, so every note you write from then on is recorded:

```
initialized a brain in ~/garden
  config: ~/garden/.somememos/config.json
  created folders: memos/, diary/, sources/, blog/
  roles: source sources/; dated diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md; blog blog/{YYYY}/{YYYY}-{MM}-{DD}-*.md blog/; memo memos/
  baseline: indexed 0 notes; the first index of a brain logs no events (3.8 ms)
```

Then write notes as ordinary `.md` files with any editor, and commit when you have changed something:

```sh
echo "# Compost tea" > memos/compost-tea.md
somememos commit -m "ingest start a note on compost tea"
```

### An existing folder of notes

In a folder that already holds markdown, `init` creates no folders, declares no roles and does **not** index yet. That gives you the chance to declare roles first, and above all to exclude private folders before anything is read.

1. Run `somememos init`. Inside a git repository it also adds `.somememos/*.sqlite*` to `.gitignore` (the databases are local; the config can be committed).

   ```
   initialized a brain in ~/garden
     config: ~/garden/.somememos/config.json
     roles: none declared (every note is a memo)
     added '.somememos/*.sqlite*' to ~/garden/.gitignore
   hint: No folder roles are declared, so every note is a memo. Before the first index, declare roles in .somememos/config.json if some folders hold diaries, sources or private notes, for example "roles": {"memo": ["memos/"], "dated": ["diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md"], "source": ["sources/"], "blog": ["blog/{YYYY}/{YYYY}-{MM}-{DD}-*.md", "blog/"], "excluded": ["private/"]}. Then run 'somememos index'.
   ```

2. Edit `.somememos/config.json` and set `"roles"`. For the example brain:

   ```json
   "roles": {
     "memo": ["memos/"],
     "dated": ["diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md"],
     "source": ["sources/"],
     "excluded": ["private/"]
   }
   ```

   The rest of the file (half-lives, burst window, weights, α, keyword settings, operation tags) holds the measured defaults; leave it alone unless you are running experiments.

3. Take the first index. It records no events, because nothing is known to have changed yet:

   ```
   $ somememos index
   baseline: indexed 35 notes; the first index of a brain logs no events (57 ms)
   ```

4. If the folder is a git repository, import its history once, so the brain starts with years of activity instead of none. Try it with `--dry-run` first:

   ```
   $ somememos import-git --dry-run
   Dry run: would import 60 commits: 60 with notes, 0 ignored, 0 without notes.
   Events: 49 edit, 37 mention.
   Renames: 1 from git, 2 dangling links later created.
   Change records: 60.
   History read up to the first index (2026-11-27T09:59:40Z).
   Took 0.0 s.

   $ somememos import-git
   Imported 60 commits: 60 with notes, 0 ignored, 0 without notes.
   Events: 49 edit, 37 mention.
   Renames: 1 from git, 2 dangling links later created.
   Change records: 60.
   Stored 89 log entries and 60 change records; skipped 0 already stored.
   Folded 86 events and 3 renames.
   History read up to the first index (2026-11-27T09:59:40Z).
   Took 0.0 s.
   ```

   Each commit that changed a memo becomes an `edit` event, each `[[link]]` it added a `mention`, each commit a change record with its message, all at the commit's author time. The import stops where live indexing began, so nothing is counted twice, and its ids come from the commits, so running it again adds nothing. Only the first-parent history is walked: work on a merged branch counts once, at the merge.

   If one commit rewrote every note mechanically (a folder rename that touched every link, say), skip it with `--ignore-commit <commit>`: its renames are still followed, but it adds no events or change record. The option can be repeated. `--until <date|commit>` stops the import earlier.

5. Look around:

   ```
   $ somememos status
   brain: ~/garden
   notes: 35 (memo 14, dated 17, source 4, blog 0); 102 sections; 3 dangling link targets
   events: 49 edit, 37 mention, 0 read, 3 rename; 60 change records
   folded: through 89 of 89
   uncommitted: none
   weights: read 1, edit 1, mention 1; alpha 0.5
   half-lives: day 1d, week 7d, month 30d, year 365d; burst window 1h
   roles: excluded private/; source sources/; dated diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md; memo memos/
   ```

### The everyday flow: search, read, edit, commit

Every command first runs a quick **index pass** that notices new, changed, moved and deleted files and logs their edits, so a forgotten commit is still recorded by the next command. `--no-index` skips it.

```
$ somememos hot --limit 5
memos/beekeeping/frame-plan.md  Frame Mistakes  week 2.40
memos/beekeeping/propolis-basics.md  Propolis Basics  week 0.91
memos/beekeeping/smoker-reading.md  Smoker Reading  week 0.87
memos/telescope/mirror-basics.md  Mirror Basics  week 0.82
memos/telescope/collimation-basics.md  Collimation Basics  week 0.55

$ somememos search hive --limit 5
memos/beekeeping/propolis-basics.md  Pollen colony brood queen drone honey hive checked.
memos/beekeeping/smoker-reading.md  ## Open questions  Try try the notes early hive second brood colony small after.
memos/beekeeping/frame-log.md  ## Results  Before small hive honey veil smoker small brood with Persimmon Gale. Not a heading, inside a fence An example link:…
diary/2026/10/2026-10-05.md  ## 11:48 beekeeping  Hive notes the honey bee quick again second should. Also memos/beekeeping/frame-plan.

$ somememos read memos/beekeeping/propolis-basics.md
---
title: Propolis Basics
---

Pollen colony brood queen drone honey hive checked.
...
```

(The example brain's text is generated filler, which is why it reads oddly.)

`read` prints the note exactly as stored and records a read. Edit the file with any tool, then commit with a reason:

```
$ printf '\n## Winter check\n\nThe colony needs a [[candy-board]] before the cold.\n' >> memos/beekeeping/propolis-basics.md
$ somememos commit -m "update add the winter check"
committed 1 note (update): update add the winter check
  memos/beekeeping/propolis-basics.md

$ somememos hot --limit 3
memos/beekeeping/propolis-basics.md  Propolis Basics  week 2.91
memos/beekeeping/frame-plan.md  Frame Mistakes  week 2.40
(not written yet) candy-board  week 1.00
```

The note rose to the top (one read, one edit), and the new link to a note that doesn't exist yet, `candy-board`, appears as a dangling link.

Until you commit, every command reminds you on standard error:

```
somememos: 1 changed note not committed; run somememos commit -m "<why>"
```

### The change log

```
$ somememos log --limit 2
2026-11-27 09:59  update  add the winter check
  memos/beekeeping/propolis-basics.md
2026-11-25 20:23  session  beekeeping 20:23
  diary/2026/11/2026-11-25.md
  memos/beekeeping/frame-plan.md

$ somememos log memos/beekeeping/propolis-basics.md
2026-11-27 09:59  update  add the winter check
  memos/beekeeping/propolis-basics.md
2026-08-01 22:01  update  create propolis-basics
  memos/beekeeping/propolis-basics.md
```

## Every command

Run `somememos help <command>` (or `somememos <command> --help`) for the full help of any command, with all its options and its `--json` shape. `somememos --help` lists them all.

| Command | What it does |
|---|---|
| `search <words…>` | Keyword search over every indexed note, ranked by `--mode` (hot, trending, neglected or all). Logs nothing. |
| `hot` | Notes ranked by recent activity (the week half-life). |
| `trending` | Notes whose activity is rising, as a pace against their usual rate. |
| `neglected` | Notes that were important over a year and have gone quiet. |
| `read <path>` | Print a note exactly and record a read (`--no-record` to skip the read). |
| `commit [-m msg] [paths…]` | Record the changes since the last commit, with your reason. |
| `rm <path>` | Delete a note, recording a change. |
| `mv <from> <to>` | Rename a note; its history and scores move with it. |
| `log [path]` | The change log, newest first. |
| `history <path>` | A note's versions on the server (remote mode only). |
| `restore <path> <commit>` | Make an earlier version current again (remote mode only). |
| `diary` | Print the path of today's dated entry, creating it if needed. |
| `status` | Counts, uncommitted changes and the config in effect. |
| `init [dir]` | Make a folder a brain. |
| `connect <server> <brain> [dir]` | Make a folder a working folder for a brain on a server. |
| `clone <server> <brain> [dir]` | Make a full offline copy of a brain on a server. |
| `sync` | Send and receive changes between a clone and its server. |
| `index [--rebuild]` | Bring the index and scores up to date (every command already does this). |
| `import-git` | Once: write a folder's git history into the event log. |
| `export` | Write the event log and change records as JSON lines. |
| `import-log <file>` | Load an export into this brain's event log. |
| `eval` | Compare ranking settings by replaying the brain's history. |

More examples, continuing on the example brain after the walkthrough above:

```
$ somememos trending --limit 3
(not written yet) candy-board  pace 4.13x
memos/beekeeping/propolis-basics.md  Propolis Basics  pace 2.78x
(not written yet) finder-plan  pace 2.27x

$ somememos neglected --limit 3
memos/cartography/compass-checklist.md  Compass Checklist  year 3.32 month 0.42
memos/cartography/gridline-questions.md  Gridline Questions  year 4.99 month 0.67
memos/cartography/legend-ideas.md  Legend Ideas  year 3.36 month 0.51

$ somememos search hive --mode all --limit 3
memos/beekeeping/propolis-basics.md  Pollen colony brood queen drone honey hive checked.
memos/beekeeping/smoker-reading.md  ## Open questions  Try try the notes early hive second brood colony small after.
diary/2026/10/2026-10-05.md  ## 11:48 beekeeping  Hive notes the honey bee quick again second should. Also memos/beekeeping/frame-plan.

$ somememos diary
diary/2026/11/2026-11-27.md
somememos: 1 changed note not committed; run somememos commit -m "<why>"

$ somememos mv memos/beekeeping/frame-log.md memos/beekeeping/frame-journal.md -m "update clearer name"
renamed memos/beekeeping/frame-log.md -> memos/beekeeping/frame-journal.md

$ somememos rm memos/boatbuilding/tiller-ideas.md -m "lint remove an empty stub"
deleted memos/boatbuilding/tiller-ideas.md

$ somememos export --output ~/backup/garden-events.jsonl
wrote 156 records (93 log entries, 63 change records) to ~/backup/garden-events.jsonl

$ somememos import-log ~/backup/garden-events.jsonl      # in another, new brain
imported 93 log entries and 63 change records; skipped 0 already present; folded 89 events, 4 renames
$ somememos import-log ~/backup/garden-events.jsonl      # again: nothing new
imported 0 log entries and 0 change records; skipped 156 already present; folded 0 events, 0 renames
```

Search details: words match any of them (notes with more matches rank higher), `"quoted words"` match as a phrase, and `--since` / `--until YYYY-MM-DD` keep only notes dated by their path (dated entries and dated blog posts). `read` and `log` accept a path relative to the working directory or to the brain's root.

An export holds note paths and change messages, so it is private. `export` and `eval --detail` refuse to write inside a somememos source checkout, because that repository is public:

```
somememos export: refusing to write an event log export inside the somememos source checkout at …: brain data is private and that repository is public. Run somememos in the brain's own directory.
```

## Choosing the brain

A command uses, in order: `--brain <dir>`; the `SOMEMEMOS_BRAIN` environment variable; the nearest folder at or above the working directory that holds `.somememos/config.json`; and otherwise remote mode, if `SOMEMEMOS_SERVER`, `SOMEMEMOS_BRAIN_ID` and `SOMEMEMOS_TOKEN` are all set. A folder whose config says `"mode": "remote"` is a working folder for a brain on a server.

## Remote mode

In remote mode the brain lives on a somememos server (see [server.md](server.md)), and each command is a request to it. The examples in this section were run against a local server holding a small brain named `garden`; its address is shown as `https://brain.example.com`. The server records the read, edit and mention events, so nothing is lost when a disposable session ends.

### Three environment variables, no setup

| Variable | Meaning |
|---|---|
| `SOMEMEMOS_SERVER` | The server's URL, for example `https://brain.example.com` |
| `SOMEMEMOS_BRAIN_ID` | The brain's id on the server |
| `SOMEMEMOS_TOKEN` | The access token. A secret: keep it in a secret store, never in a file in a repository |

With all three set and no brain folder around, every command works against the server, and notes you read are placed in `~/somememos/<brain id>/` (or `SOMEMEMOS_WORKDIR`), never in the current directory, so they can't land in an unrelated repository.

### A working folder: connect

To work in a particular folder instead, connect it once:

```
$ export SOMEMEMOS_TOKEN=…
$ mkdir ~/garden-remote && cd ~/garden-remote
$ somememos connect https://brain.example.com garden
connected ~/garden-remote to brain garden on https://brain.example.com (server 0.5.0)
  config: ~/garden-remote/.somememos/config.json (no token stored; it comes from $SOMEMEMOS_TOKEN)
next: cd ~/garden-remote; somememos hot; somememos search <words>; somememos read <path>; edit; somememos commit -m "<why>"
```

`connect` checks that the server answers and accepts the token before writing anything. It refuses a folder that already holds markdown or is already a brain. The token is never written to the folder: it comes from `SOMEMEMOS_TOKEN`, or from `--token-file <path>`, a file outside the folder whose path (not its content) is recorded. Inside a git repository it adds a `.gitignore` that keeps the folder's notes out of git.

The server must be `https://`. The CLI refuses to send the token over plain `http://`, where anyone on the network can read it, except to this machine (`localhost`, `127.0.0.1`, `[::1]`). On a network you trust, pass `--allow-insecure` to `connect`, `clone` or `sync`, or set `SOMEMEMOS_ALLOW_INSECURE=1` (which every command of a working folder or environment-only mode on such a server needs).

### Read, edit, commit

```
$ somememos read memos/compost-tea.md
# Compost tea

Steep for two days. See [[aeration]].
```

`read` prints the note and also places it in the working folder at the same path. Edit that file, then commit:

```
$ printf 'Stir twice a day.\n' >> memos/compost-tea.md
$ somememos commit -m "update stirring"
committed 1 note (update): update stirring
  memos/compost-tea.md
```

`commit` sends each file you edited, and each new `.md` file, with the version it had when you read it. A new note is just a new file in the working folder:

```
$ printf '# Aeration\n\nAn aquarium pump works.\n' > memos/aeration.md
$ somememos commit -m "ingest aeration"
committed 1 note (ingest): ingest aeration
  memos/aeration.md (new)
```

Reading a note again fetches the server's newer version if you have not edited your copy; if you have, it prints your copy and warns when the server's version moved on. `somememos status` lists edited files, new files, files that changed on the server since you read them ("behind"), and files deleted locally.

### Stale commits and `.server.md`

If someone else changed a note after you read it, your commit is refused for that file only (other files still go through), the exit code is 1, and the server's version is saved beside yours:

```
$ somememos commit -m "update water"
somememos commit: memos/compost-tea.md: not committed: the server has a newer version, saved as memos/compost-tea.server.md; merge it into memos/compost-tea.md, delete memos/compost-tea.server.md, then commit again
```

Your file is never touched. Merge the server's text into your file, delete `compost-tea.server.md` (that tells the CLI the merge is done), and commit again.

### Deleting and renaming

Deleting or moving a file in the working folder changes nothing on the server. Use the commands:

```
$ somememos mv memos/aeration.md memos/aeration-pump.md -m "update clearer name"
renamed memos/aeration.md -> memos/aeration-pump.md
```

`somememos rm <path> -m <why>` is meant to delete a note on the server. **In 0.5.0 it fails against the real server** with "answered HTTP 403 without a somememos response"; see [Known limitations](#known-limitations).

### History and restore

The server keeps every version of every note in git. `history` lists them, following renames, and `restore` makes an earlier one current again, as a new version (nothing is rewritten):

```
$ somememos history memos/compost-tea.md
2026-11-27 11:42  bcae4f8e0828  5da950df-9772-42dc-8f94-44b3aa15c265  update lid
2026-11-27 11:42  57b05b293f78  server  ingest first notes

$ somememos restore memos/compost-tea.md 57b05b293f78 -m "update undo the lid note"
restored memos/compost-tea.md to 57b05b293f78
```

The third column is the client that made the change: a random client id for a CLI or web app, or `server` for a change made through the API directly. Give `restore` the commit hash from `history` (a prefix is enough; names such as `HEAD` are refused).

## Offline copies: clone and sync

`clone` makes a full local-mode copy of a brain on a server, with its notes as ordinary files and its whole event log, so every local command works offline. Folder roles come from the server.

```
$ somememos clone https://brain.example.com garden ~/garden-copy
cloned brain garden from https://brain.example.com into ~/garden-copy
  2 notes, 5 events, 2 change records
next: cd ~/garden-copy; work offline with the local commands; somememos sync to send and get changes
```

Work as in local mode (edit, `commit`), then `sync` to push your edits, events and change records and pull what changed on the server:

```
$ somememos status
...
sync: brain garden on https://brain.example.com; last synced 2026-11-27 11:42; to push: 1 note, 1 event, 1 change record (somememos sync)

$ somememos sync
synced with brain garden on https://brain.example.com: pushed 1 edit (1 applied), 1 event, 1 change record; received 0 notes, 0 events, 0 change records
```

A note changed both here and on the server is a conflict: the server's version takes the path, and yours is kept beside it as `<name>.conflict-<client>-<date>.md`. Merge it by hand and delete the conflict file.

A brain that began on this machine can be pushed to a server with `somememos sync --server <url> --brain-id <id>` once. The brain must already exist on the server and declare the same folder roles.

## Output, `--json` and exit codes

Output is short plain text, one result per line, meant to be read by people and agents alike. `--json`, before or after the command name, prints one JSON record instead, with the full details, including every score component behind a rank:

```
$ somememos hot --json --limit 1
{
  "mode": "hot",
  "query": null,
  "at": 1795773595,
  "results": [
    {
      "item": "memos/beekeeping/propolis-basics.md",
      "path": "memos/beekeeping/propolis-basics.md",
      "dangling": false,
      "title": "Propolis Basics",
      "role": "memo",
      ...
      "now": {
        "activation": { "day": 2.04, "month": 4.33, "week": 2.91, "year": 6.57 },
        ...
```

(Shortened; the real record carries full-precision numbers.) The `now` block holds scores as of `at`; the `components` block holds the stored log scores the rank was computed from.

Exit codes: **0** success (including "no results"), **1** an error (a missing note, a refused commit, an unreachable server), **2** bad usage (an unknown command or option). Errors are one line on standard error:

```
$ somememos read memos/nope.md
somememos read: no note at memos/nope.md                          (exit 1)
$ somememos read private/journal.md
somememos read: that path is excluded from somememos              (exit 1)
$ somememos frobnicate
somememos: unknown command 'frobnicate'
Run 'somememos --help' for usage.                                 (exit 2)
```

Set `SOMEMEMOS_DEBUG=1` for stack traces.

## Evaluating ranking settings: eval

`somememos eval` replays the brain's own history to compare ranking settings, and prints recall and mean reciprocal rank for each. It logs nothing and changes no score. This is how somememos chooses its defaults (see [concepts.md](concepts.md#set-by-experiment)).

**The cases.**

- **Orientation cases** (always, unless `--no-orientation`): at `--samples` random past moments (default 100), only the events before that moment are folded into scores, and the right answers are the memos, blog posts and dangling links that had events in the following `--window` (default `7d`). This tests the activity lists on their own, the way an agent uses `somememos hot` at the start of a session. Moments with too little history before them are skipped.
- **Search cases from git** (`--from-git`): for sampled commits, the query is the commit message and the right answers are the memos it changed. The keyword index is rebuilt in memory as of the commit's parent, so later text can't give the answer away. Commits that changed more than 20 notes are skipped.
- **Hand-written search cases** (`--cases <file>`): a JSON lines file of `{"query": "...", "time": <unix seconds or ISO date>, "answers": ["memos/..."]}`, with `time` optional. Keep it inside the brain, for example in `.somememos/eval/`.

**The settings.** Named presets, which can be repeated:

| Preset | Compares |
|---|---|
| `baseline` (default with search cases) | keywords only (mode all) against keywords plus activation (mode hot) |
| `weights` | the mention weight (edit = 1) and α |
| `half-lives` (default without search cases) | which half-life drives hot: day, week, month or year |
| `bursts` | the burst window: off, 10 minutes, 1 hour, 1 day |
| `keyword` | BM25F's k1, the title weight and body length normalization |
| `spreading` | spreading activation along links, in several directions and strengths |

`--grid 'key=v1,v2;key=v1,v2'` makes a setting of every combination, for example `--grid 'alpha=0,0.5,1;weights.mention=0.5,1'`. `somememos help eval` lists every key. `--seed` makes the sampling repeatable.

**Reading the table.**

```
$ somememos eval --preset baseline --from-git --samples 50
cases: 35 orientation (skipped 15 for too little history, 0 with no answers), 0 hand-written, 35 from git (of 35 eligible commits); 2 settings; seed 1

orientation cases
setting     R@1    R@5   R@10   R@20    MRR  cases  skipped
--------  -----  -----  -----  -----  -----  -----  -------
mode=all  0.272  0.479  0.837  0.897  0.727     35        0
mode=hot  0.272  0.479  0.837  0.897  0.727     35        0

search cases
setting     R@1    R@5   R@10   R@20    MRR  cases  skipped
--------  -----  -----  -----  -----  -----  -----  -------
mode=all  0.714  0.857  0.886  0.886  0.777     35        0
mode=hot  0.686  0.886  0.886  0.886  0.781     35        0
```

`R@10` is recall at 10: the share of right answers that appear in the top ten, averaged over cases. `MRR` is the mean reciprocal rank: 1 divided by the position of the first right answer (1.0 when it is first, 0.5 when second), averaged. Higher is better for both. Differences of a couple of hundredths are noise on a brain this size.

Orientation cases have no keywords, so `mode=all` and `mode=hot` rank them identically and the two orientation rows always match; compare settings on the search table, or use a preset such as `half-lives` for orientation. Plain `somememos eval`, with no `--cases` or `--from-git`, has only orientation cases, so it compares `half-lives` instead of `baseline` and prints a note saying so; `--preset baseline` without search cases prints a note that its rows cannot differ:

```
$ somememos eval --preset half-lives --window 1d
cases: 32 orientation (skipped 26 for too little history, 42 with no answers), 0 hand-written, 0 from git; 4 settings; seed 1

orientation cases
setting                R@1    R@5   R@10   R@20    MRR  cases  skipped
-------------------  -----  -----  -----  -----  -----  -----  -------
halfLives.hot=day    0.292  0.625  0.844  0.891  0.509     32        0
halfLives.hot=week   0.188  0.531  0.844  0.891  0.396     32        0
halfLives.hot=month  0.255  0.422  0.828  0.891  0.480     32        0
halfLives.hot=year   0.193  0.396  0.641  0.891  0.441     32        0
```

**Privacy by design.** The default output is aggregate numbers only: no query, path or title, so it is safe to share. Per-case results (queries, paths and rankings) are written only with `--detail`, only into the brain's own `.somememos/eval/` folder, and never inside a somememos source checkout.

## An example brain

The examples here use an invented brain from the project's generator: six made-up hobbies (beekeeping, telescopes, cartography and so on), a diary, sources, a `private/` folder to exclude, and a git history of 60 commits over 120 days ending yesterday. To make it, from a built checkout:

```sh
node docs/scripts/example-brain.mjs ~/garden            # a git repository
node docs/scripts/example-brain.mjs ~/garden --files    # files only, no history
```

Put it outside the checkout. Then follow [An existing folder of notes](#an-existing-folder-of-notes).

## Known limitations

- **`somememos rm` fails in remote mode against the real server** (0.5.0). The web server refuses a `DELETE` request without a content type as a cross-site form submission, before somememos sees it, and the CLI reports "the server at … answered HTTP 403 without a somememos response; check the server URL". The CLI's own tests pass because they run the API without the web server around it. Until it is fixed, delete a note by renaming it out of the way, or with the web app (which deletes through sync), or by calling the API with a JSON content type (see [server.md](server.md#notes)).
- **In environment-variable remote mode, `hot` and `search` print absolute paths** into `~/somememos/<brain id>/` instead of brain-relative paths. `read` accepts either form, so it works, but the output is long.
- **In remote mode, one `commit` of several notes makes one change record per note**, each with the same message, so `somememos log` shows the commit once for every note. In local mode a commit is one change record.
- **`somememos diary` creates the file, and the reminder then counts it as an uncommitted change** right away, before you have written anything.
- **The default `eval` compares two settings that are identical on orientation cases** (see above), so its first table never shows a difference.
- **`history` names clients by their random id**, which says little about who made a change.
- After a rename on the server, `history` of the new path lists the rename's version twice, once without and once with "(renamed to …)".
- **No release download** yet: install from a clone or build the bundle.
- **Not tested on Windows or macOS** in this round; the CLI was run on Linux.
