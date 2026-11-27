// `somememos help agents`: the agent-facing guide (PLAN.md section 6, "Agents
// use the CLI"; IMPLEMENTATION.md task 4.3), short enough to paste into a
// brain's AGENTS.md. `somememos help setup`: using a brain on a server from a
// fresh machine or cloud session (IMPLEMENTATION.md tasks 4.1 and 4.5).

export const AGENTS_GUIDE = `## Working in a brain with somememos

A somememos brain is markdown notes plus a time-aware index of what has been
read, edited and linked. Use the CLI, not grep and cat. The flow is the same
whether the brain is a local folder or on a server (remote mode):

1. Orient: \`somememos hot\` lists what is active now (also \`trending\`,
   \`neglected\`); \`somememos log\` shows what changed recently and why.
2. Search before you grep: \`somememos search <words>\` prints one note per
   line (path, heading, snippet). \`--mode all\` ranks by keywords only.
3. Read with \`somememos read <path>\`, never cat: it prints the note exactly
   and records the read. In remote mode it also places the note in the
   working folder at that path; edit that file.
4. Edit with your usual tools; new notes are new .md files. Write today's
   diary entry at the path \`somememos diary\` prints.
5. Commit with a reason: \`somememos commit -m "<op> <summary>"\` (op: ingest,
   update, session, query or lint). In remote mode, if someone changed a note
   meanwhile, commit saves theirs as <name>.server.md: merge it into your
   file, delete the .server.md, and commit again. Delete and rename only with
   \`somememos rm\` and \`somememos mv\`; never write changelog files.

Every command reminds you of uncommitted edits. \`--json\` gives full records.
Exit codes: 0 ok, 1 error, 2 bad usage. \`somememos help setup\` covers remote
mode (set SOMEMEMOS_CLIENT_ID to name your session in \`somememos history\`);
\`somememos help <command>\` explains any command.
`;

/** Placeholder for the bundle's download URL: there is no release yet. */
export const INSTALL_URL_PLACEHOLDER = '<SOMEMEMOS-RELEASE-URL>/somememos.mjs';

export const SETUP_GUIDE = `## Using a brain on a server (cloud sessions, new machines)

Install the one-file CLI (needs only Node 22.13 or later):

  mkdir -p ~/.local/bin && curl -fsSL ${INSTALL_URL_PLACEHOLDER} -o ~/.local/bin/somememos && chmod +x ~/.local/bin/somememos

(${INSTALL_URL_PLACEHOLDER} is a placeholder until there is a release; build
the file with \`npm run bundle -w @somememos/cli\`.)

Remote mode with no files: set three environment variables, and every
command is a request to the server.

  SOMEMEMOS_SERVER    the server's URL, e.g. https://brain.example.com
  SOMEMEMOS_BRAIN_ID  the brain's id on the server
  SOMEMEMOS_TOKEN     the access token (a secret: keep it in the session's
                      secret store, never in a file in a repository)

Notes you read go to the working folder, SOMEMEMOS_WORKDIR (default
~/somememos/<brain id>); edit them there and commit. Optionally:

  SOMEMEMOS_CLIENT_ID a readable name for this device or session, e.g.
                      cloud-agent (letters, digits, '.', '_', ':' or '-');
                      \`somememos history\` and the server's git commits show
                      it as the author. Default: an id derived from this
                      machine, user and working folder. Never put a secret
                      in it.

Or make a folder a working folder once (the token still comes from
SOMEMEMOS_TOKEN, or --token-file outside the folder; it is never stored):

  somememos connect https://brain.example.com <brain-id> ~/brain --name work-laptop
  cd ~/brain && somememos hot

For offline use (or local models), make a full copy and sync it:

  somememos clone https://brain.example.com <brain-id> ~/brain --name work-laptop
  somememos sync

--name gives the folder or copy its client id (1-40 letters, digits, '.',
'_' or '-'; default a random id), shown in history; give each device its own.

The server must be https://: the CLI refuses to send the token over plain
http:// (anyone on the network could read it), except to this machine
(localhost, 127.0.0.1, [::1]). On a network you trust, pass --allow-insecure
to connect, clone or sync, or set SOMEMEMOS_ALLOW_INSECURE=1 (needed for
every command of a working folder or environment-only mode on such a server).

Then follow \`somememos help agents\`.
`;
