// `somememos help agents`: the agent-facing guide (PLAN.md section 6, "Agents
// use the CLI"; IMPLEMENTATION.md task 4.3), short enough to paste into a
// brain's AGENTS.md.

export const AGENTS_GUIDE = `## Working in this brain with somememos

This folder is a somememos brain: markdown notes plus a time-aware index of
what has been read, edited and linked. Use the CLI, not grep and cat:

1. Orient: \`somememos hot\` lists what is active now (also \`trending\`,
   \`neglected\`), and \`somememos log\` shows what changed recently and why.
2. Search before you grep: \`somememos search <words>\` prints one note per
   line (path, heading, snippet). Add \`--mode all\` for keyword relevance only.
3. Read with \`somememos read <path>\`, never cat: it prints the note exactly
   and records the read, so notes you use rank higher next time.
4. Edit the files in place with your usual tools. Write today's diary entry at
   the path \`somememos diary\` prints.
5. Commit with a reason: \`somememos commit -m "<op> <summary>"\`, where <op> is
   ingest, update, session, query or lint. Don't write changelog files; the
   commit message is the change log.

Add \`--json\` for full records with score components. Exit codes: 0 ok,
1 error, 2 bad usage. \`somememos help <command>\` explains any command.
`;
