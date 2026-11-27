# Setting up an AI agent

somememos was built first of all as memory for AI agents. An agent with a shell uses the `somememos` command-line tool: it orients itself with `somememos hot`, searches with `somememos search`, reads with `somememos read`, edits files with its usual tools, and records why with `somememos commit -m`. This page is for the person setting that up. The commands themselves are described in [cli.md](cli.md).

There is no MCP server yet, so an agent without a shell cannot use a brain today.

## 1. Paste the agent guide into the brain's instructions

The CLI prints a short guide meant to be pasted into a brain's `AGENTS.md` (or `CLAUDE.md`, or whatever instructions file your agent reads). **`somememos help agents` is the source of this text**: copy it from the CLI you install, so it matches that version. For version 0.5.0 it reads:

```markdown
## Working in a brain with somememos

A somememos brain is markdown notes plus a time-aware index of what has been
read, edited and linked. Use the CLI, not grep and cat. The flow is the same
whether the brain is a local folder or on a server (remote mode):

1. Orient: `somememos hot` lists what is active now (also `trending`,
   `neglected`); `somememos log` shows what changed recently and why.
2. Search before you grep: `somememos search <words>` prints one note per
   line (path, heading, snippet). `--mode all` ranks by keywords only.
3. Read with `somememos read <path>`, never cat: it prints the note exactly
   and records the read. In remote mode it also places the note in the
   working folder at that path; edit that file.
4. Edit with your usual tools; new notes are new .md files. Write today's
   diary entry at the path `somememos diary` prints.
5. Commit with a reason: `somememos commit -m "<op> <summary>"` (op: ingest,
   update, session, query or lint). In remote mode, if someone changed a note
   meanwhile, commit saves theirs as <name>.server.md: merge it into your
   file, delete the .server.md, and commit again. Delete and rename only with
   `somememos rm` and `somememos mv`; never write changelog files.

Every command reminds you of uncommitted edits. `--json` gives full records.
Exit codes: 0 ok, 1 error, 2 bad usage. `somememos help setup` covers remote
mode; `somememos help <command>` explains any command.
```

To refresh it after upgrading: `somememos help agents > /tmp/somememos-agents.md` and paste the result over the old section.

If the brain's instructions say anything that conflicts (for example "append to a changelog file", "orient with grep", or "read notes with cat"), remove those lines: somememos keeps the change log itself, from commit messages.

## 2. Give the agent access

**A brain in a local folder.** Install the CLI where the agent runs (see [cli.md](cli.md#installing)) and start the agent in the brain's folder, or set `SOMEMEMOS_BRAIN=/path/to/brain`. Nothing else is needed.

**A brain on a server, from a cloud session or a new machine.** `somememos help setup` prints the steps. In short:

1. Install the one-file CLI in the session's setup script. The command `help setup` prints downloads from `<SOMEMEMOS-RELEASE-URL>`, which is a placeholder: **there is no release yet**, so build `packages/cli/bundle/somememos.mjs` with `npm run bundle -w @somememos/cli` and make it available to the session yourself (for example from a private location you control).
2. Set three environment variables. Keep the token in the session's secret store, never in a file in a repository:

   ```
   SOMEMEMOS_SERVER    the server's URL, e.g. https://brain.example.com
   SOMEMEMOS_BRAIN_ID  the brain's id on the server
   SOMEMEMOS_TOKEN     the access token
   ```

3. Optionally set `SOMEMEMOS_CLIENT_ID` to a readable name such as `cloud-agent`, so the change log and note history say which agent made a change. Without it, the CLI derives a stable id like `cli-3f9a…` from the machine, user and working folder.

With those set, every command is a request to the server from any directory, and the notes the agent reads land in `~/somememos/<brain id>/` (or `SOMEMEMOS_WORKDIR`), never in the repository the agent happens to be working in. Alternatively, `somememos connect <server> <brain> <dir>` makes a dedicated working folder, and `somememos clone` makes a full offline copy for local models (see [cli.md](cli.md#remote-mode)).

The token is never stored by the CLI and never printed, not even in error messages.

## Why `somememos read` and not `cat`

The hot list is built from what was actually used. A note an agent reads with `cat` leaves no trace, so the notes it relies on most never rise; read with `somememos read`, the same note gains a `read` event and ranks higher in `hot` and in hot-mode search the next time any agent or person looks. `read` prints the text exactly as stored, byte for byte, so nothing is lost by using it. In remote mode, `read` is also how the note reaches the working folder, with the version it was based on, so a later `commit` can tell whether someone else changed it in the meantime.

Searching does not count: appearing in `search` or `hot` output records nothing, so a note does not become popular just by being listed.

## What gets recorded when an agent works

| The agent runs | What is recorded |
|---|---|
| `somememos hot`, `trending`, `neglected`, `search`, `log`, `status` | Nothing. |
| `somememos read <memo or blog post>` | One `read` event for that note, at the current time, under the agent's client id. Reading a diary entry or a source records nothing. `--no-record` skips the event. |
| `somememos commit -m "update …"` | For each changed memo or blog post, an `edit` event; for each `[[link]]` the change added, a `mention` event for the note (or not-yet-written note) it points to; and a change record with the time, the client id, the notes and the message. In local mode that is one change record for the whole commit; in remote mode each note is saved separately, so each gets its own change record and its own git commit on the server, all with the same message. |
| `somememos mv` | A `rename` record, so the note keeps its history, plus a change record. |
| `somememos diary` | Creates today's entry if needed; the entry itself is not scored. |

Repeated events on one note within an hour count once when scores are computed (the burst rule; see [concepts.md](concepts.md#the-burst-rule)), so an agent that reads the same note five times in a session does not inflate it. Every event is still kept in the log.

Search queries are never logged. Excluded folders never appear in any output, event or error message: `somememos read private/journal.md` answers only "that path is excluded from somememos".

## A note on the feedback loop

An agent that reads whatever the hot list shows it will push those notes further up the hot list. Whether reads need a smaller weight to prevent that is an open question (PLAN.md section 12), to be measured once enough real reads have been collected. For now every kind of event has weight 1.

## Known limitations

- **No release download**, so a cloud session needs the bundle supplied by hand (above).
- **`somememos rm` fails against the real server** in 0.5.0 (see [cli.md](cli.md#known-limitations)). Tell agents to rename unwanted notes out of the way, or to leave deletion to a person, until it is fixed.
- **No packaged skill**, only the pasted guide.
- **No MCP server**: agents without a shell can't use a brain yet.
- `somememos help setup` does not mention `SOMEMEMOS_CLIENT_ID`.
