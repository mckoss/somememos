// Remote mode, offline copies and sync against a real server: the server's
// own handler (`@somememos/server`) on a local HTTP port with a Postgres
// schema of its own. Skipped without SOMEMEMOS_TEST_DATABASE_URL. All content
// is invented (the synthetic brain generator, or notes written here).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeContext, tempDir, writeTestConfig } from '../brain/testing.js';
import { EXIT_FAILURE, EXIT_OK, run } from '../index.js';
import {
  EXCLUDED_FOLDER,
  type SyntheticBrain,
  filesAfter,
  generateBrain,
  materializeGitHistory,
} from '../testing/index.js';
import { TEST_TOKEN, type TestServer, describePg, startTestServer } from '../testing/server.js';
import { sidecarKind } from './config.js';

const NOW = 1_760_000_000;
const ROLES = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  blog: ['blog/{YYYY}/{YYYY}-{MM}-{DD}-*.md', 'blog/'],
  excluded: [`${EXCLUDED_FOLDER}/`],
};

/** Every stdout and stderr the tests saw, to search for the token at the end. */
const outputs: string[] = [];
/** Every folder the CLI wrote, to search for the token at the end. */
const folders: string[] = [];

let tmp: ReturnType<typeof tempDir>;
let home: string;

type Result = { code: number; stdout: string; stderr: string };

async function cli(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  now = NOW,
): Promise<Result> {
  const io = fakeContext({
    cwd,
    now,
    env: { HOME: home, SOMEMEMOS_TOKEN: TEST_TOKEN, ...env },
  });
  const code = await run(args, io.ctx);
  const r = { code, stdout: io.stdout(), stderr: io.stderr() };
  outputs.push(r.stdout, r.stderr);
  return r;
}

async function ok(cwd: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = await cli(cwd, args, env);
  expect(r.code, `${args.join(' ')}: ${r.stderr}`).toBe(EXIT_OK);
  return r;
}

async function json<T>(cwd: string, args: string[], env: Record<string, string | undefined> = {}) {
  return JSON.parse((await ok(cwd, [...args, '--json'], env)).stdout) as T;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(full);
    }
  };
  if (existsSync(dir)) visit(dir);
  return out;
}

function newDir(name: string): string {
  const dir = join(tmp.dir, name);
  folders.push(dir);
  return dir;
}

let server: TestServer;

/** A port nothing listens on. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describePg(
  'remote mode against a real server',
  () => {
    let brain: SyntheticBrain;
    let local: string;
    let work: string;
    let files: Map<string, string>;
    let memos: string[];

    beforeAll(async () => {
      tmp = tempDir('somememos-remote-');
      home = join(tmp.dir, 'home');
      mkdirSync(home);
      folders.push(home);
      server = await startTestServer({ now: NOW });

      // The same invented brain, loaded both ways: a local brain with its
      // history imported, pushed once to the server's brain "garden".
      brain = generateBrain({ seed: 5 });
      local = newDir('local');
      materializeGitHistory(local, brain);
      writeTestConfig(local, { roles: ROLES });
      await ok(local, ['index']);
      await ok(local, ['import-git']);
      await server.createBrain('garden', ROLES);
      const pushed = await ok(local, ['sync', '--server', server.url, '--brain-id', 'garden']);
      expect(pushed.stdout).toMatch(
        /^synced with brain garden on http:\/\/127\.0\.0\.1:\d+: pushed \d+ edits/,
      );

      work = newDir('work');
      const connected = await ok(tmp.dir, ['connect', server.url, 'garden', work]);
      expect(connected.stdout).toContain(`connected ${work} to brain garden on ${server.url}`);
      files = filesAfter(brain.steps);
      memos = [...files.keys()].filter((p) => p.startsWith('memos/')).sort();
    }, 120_000);

    afterAll(async () => {
      await server?.close();
      tmp?.remove();
    });

    it('connect wrote a remote config with no token, which local-only commands refuse clearly', async () => {
      const kind = sidecarKind(work);
      expect(kind.kind).toBe('remote');
      const text = readFileSync(join(work, '.somememos', 'config.json'), 'utf8');
      expect(Object.keys(JSON.parse(text)).sort()).toEqual([
        'brainId',
        'clientId',
        'mode',
        'server',
      ]);
      const r = await cli(work, ['index']);
      expect(r.code).toBe(EXIT_FAILURE);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toMatch(/works only in local mode/);
      // A second connect into the same folder changes nothing.
      expect((await cli(tmp.dir, ['connect', server.url, 'garden', work])).code).toBe(EXIT_FAILURE);
    });

    it('every query command prints the same in remote mode as in local mode', async () => {
      const word = brain.topics[0]?.name as string;
      const other = brain.topics[1]?.name as string;
      const commands: string[][] = [
        ['hot'],
        ['trending'],
        ['neglected'],
        ['hot', '--limit', '3'],
        ['search', word],
        ['search', word, '--mode', 'all'],
        ['search', other, '--mode', 'trending', '--limit', '5'],
        ['search', word, '--mode', 'neglected'],
        ['search', word, '--since', '2025-02-01', '--until', '2025-04-30'],
        ['log'],
        ['log', '--all', '--limit', '0'],
        ['log', '--op', 'ingest'],
        ['log', memos[0] as string],
        ['log', '--all', '--query', word, '--limit', '0'],
      ];
      for (const args of commands) {
        const l = await cli(local, args);
        const r = await cli(work, args);
        expect(r.code, `${args.join(' ')}: ${r.stderr}`).toBe(l.code);
        expect(r.stdout, args.join(' ')).toBe(l.stdout);
        if (!args.includes('--since')) expect(l.stdout, args.join(' ')).not.toBe('');
        const lj = await cli(local, [...args, '--json']);
        const rj = await cli(work, [...args, '--json']);
        expect(JSON.parse(rj.stdout), `${args.join(' ')} --json`).toEqual(JSON.parse(lj.stdout));
      }
      // Same usage errors and exit codes.
      for (const args of [['search'], ['hot', 'words'], ['log', '--limit', 'x']]) {
        expect((await cli(work, args)).code).toBe((await cli(local, args)).code);
      }

      // Status: the same counts (the server's), plus the working folder.
      const ls = await json<Record<string, unknown>>(local, ['status']);
      const rs = await json<Record<string, unknown>>(work, ['status']);
      for (const key of ['notes', 'sections', 'dangling', 'events', 'changes', 'config']) {
        expect(rs[key], key).toEqual(ls[key]);
      }
      expect(rs.workingFolder).toEqual({ edited: [], new: [], behind: [], missing: [] });

      // Diary: the same path, and the entry is placed in the working folder.
      const ld = await ok(local, ['diary', '--date', '2025-07-01']);
      const rd = await ok(work, ['diary', '--date', '2025-07-01']);
      expect(rd.stdout).toBe(ld.stdout);
      expect(readFileSync(join(work, rd.stdout.trim()), 'utf8')).toBe(
        readFileSync(join(local, ld.stdout.trim()), 'utf8'),
      );

      // Read: byte for byte, logged once on each side; the lists still agree.
      const path = memos[2] as string;
      const lr = await ok(local, ['read', path]);
      const rr = await ok(work, ['read', path]);
      expect(rr.stdout).toBe(lr.stdout);
      expect(rr.stdout).toBe(files.get(path));
      expect(readFileSync(join(work, path), 'utf8')).toBe(files.get(path));
      expect(JSON.parse((await ok(work, ['hot', '--json'])).stdout)).toEqual(
        JSON.parse((await ok(local, ['hot', '--json'])).stdout),
      );
    });

    it('read, edit and commit: edits, new notes, the reminder, and status', async () => {
      const [a, b] = [memos[3] as string, memos[4] as string];
      await ok(work, ['read', a]);
      await ok(work, ['read', b, '--no-record']);
      const manifest = JSON.parse(readFileSync(join(work, '.somememos', 'manifest.json'), 'utf8'));
      expect(Object.keys(manifest.notes)).toEqual(expect.arrayContaining([a, b]));

      writeFileSync(join(work, a), `${files.get(a)}\nA line added in the working folder.\n`);
      mkdirSync(join(work, 'memos', 'fresh'), { recursive: true });
      writeFileSync(
        join(work, 'memos/fresh/idea.md'),
        '# A fresh idea\n\nPlanted in remote mode.\n',
      );

      const hot = await ok(work, ['hot']);
      expect(hot.stderr).toBe(
        'somememos: 2 changed notes not committed; run somememos commit -m "<why>"\n',
      );
      expect((await ok(work, ['hot', '--json'])).stderr).toBe('');

      const status = await ok(work, ['status']);
      expect(status.stderr).toBe('');
      expect(status.stdout).toContain(`brain: garden on ${server.url} (remote)`);
      expect(status.stdout).toContain(`edited: 1 note not committed`);
      expect(status.stdout).toContain(`\n  ${a}\n`);
      expect(status.stdout).toContain(`new: 1 note not committed`);
      expect(status.stdout).toContain('\n  memos/fresh/idea.md\n');

      const commit = await ok(work, ['commit', '-m', 'update add a line and an idea']);
      expect(commit.stderr).toBe('');
      expect(commit.stdout).toBe(
        `committed 2 notes (update): update add a line and an idea\n  ${a}\n  memos/fresh/idea.md (new)\n`,
      );
      expect((await ok(work, ['hot'])).stderr).toBe('');
      expect((await ok(work, ['commit'])).stdout).toBe(
        'nothing to commit: no edited or new files in the working folder\n',
      );
      // Another working folder sees the new versions; the server logged the change.
      const other = newDir('other');
      await ok(tmp.dir, ['connect', server.url, 'garden', other]);
      expect((await ok(other, ['read', a])).stdout).toBe(
        `${files.get(a)}\nA line added in the working folder.\n`,
      );
      expect((await ok(other, ['read', 'memos/fresh/idea.md'])).stdout).toContain('Planted');
      const log = await ok(work, ['log', '--limit', '2']);
      expect(log.stdout).toContain('update  add a line and an idea');
    });

    it('one commit is one change set; a stale base refuses it all and keeps both versions', async () => {
      const [a, b] = [memos[5] as string, memos[6] as string];
      const mine = newDir('mine');
      const theirs = newDir('theirs');
      await ok(tmp.dir, ['connect', server.url, 'garden', mine]);
      await ok(tmp.dir, ['connect', server.url, 'garden', theirs]);
      for (const dir of [mine, theirs]) {
        await ok(dir, ['read', a]);
        await ok(dir, ['read', b]);
      }
      writeFileSync(join(theirs, a), `${files.get(a)}\nTheir change.\n`);
      await ok(theirs, ['commit', '-m', 'update their change']);

      writeFileSync(join(mine, a), `${files.get(a)}\nMy change.\n`);
      writeFileSync(join(mine, b), `${files.get(b)}\nMy other change.\n`);
      // Reading the edited file again prints my copy and warns.
      const again = await cli(mine, ['read', a]);
      expect(again.code).toBe(EXIT_OK);
      expect(again.stdout).toBe(`${files.get(a)}\nMy change.\n`);
      expect(again.stderr).toMatch(/server has a newer version/);

      // One stale file refuses the whole commit: nothing of it lands.
      const refused = await cli(mine, ['commit', '-m', 'update my changes']);
      expect(refused.code).toBe(EXIT_FAILURE);
      expect(refused.stdout).toBe(
        'not committed: 1 other note sent with a conflicting one; nothing of this commit landed, so commit again once the conflict is merged\n',
      );
      const copy = a.replace(/\.md$/, '.server.md');
      expect(refused.stderr.trim().split('\n')).toEqual([
        `somememos commit: ${a}: not committed: the server has a newer version, saved as ${copy}; merge it into ${a}, delete ${copy}, then commit again`,
      ]);
      expect(readFileSync(join(mine, a), 'utf8')).toBe(`${files.get(a)}\nMy change.\n`);
      expect(readFileSync(join(mine, copy), 'utf8')).toBe(`${files.get(a)}\nTheir change.\n`);
      expect((await ok(theirs, ['read', b])).stdout).toBe(files.get(b));
      // Committing again before merging is refused again for that file.
      const still = await cli(mine, ['commit', a]);
      expect(still.code).toBe(EXIT_FAILURE);
      expect(still.stderr).toMatch(/merge .* into it, delete/);

      writeFileSync(join(mine, a), `${files.get(a)}\nTheir change.\nMy change.\n`);
      rmSync(join(mine, copy));
      const merged = await ok(mine, ['commit', '-m', 'update merge']);
      // Both files land as one change record.
      expect(merged.stdout).toBe(`committed 2 notes (update): update merge\n  ${a}\n  ${b}\n`);
      const log = (
        await json<{ changes: { message: string; paths: string[] }[] }>(mine, [
          'log',
          '--limit',
          '1',
        ])
      ).changes;
      expect(log[0]?.message).toBe('update merge');
      expect([...(log[0]?.paths ?? [])].sort()).toEqual([a, b].sort());
      expect((await ok(theirs, ['read', b])).stdout).toContain('My other change.');
      // The other folder's copy is untouched, so a repeated read fetches the merge.
      expect((await ok(theirs, ['read', a])).stdout).toBe(
        `${files.get(a)}\nTheir change.\nMy change.\n`,
      );
      expect(readFileSync(join(theirs, a), 'utf8')).toContain('My change.');
    });

    it('rm and mv are explicit; a file deleted locally deletes nothing', async () => {
      const [a, b] = [memos[7] as string, memos[8] as string];
      const dir = newDir('files');
      await ok(tmp.dir, ['connect', server.url, 'garden', dir]);
      await ok(dir, ['read', a]);
      await ok(dir, ['read', b]);

      rmSync(join(dir, a));
      expect((await ok(dir, ['commit'])).stdout).toMatch(/^nothing to commit/);
      expect((await ok(dir, ['status'])).stdout).toContain(`missing: 1 note deleted here`);
      expect((await ok(newDir('check1'), ['read', a], envOnly())).stdout).toBe(files.get(a));

      // An edited copy is refused; an untouched one goes with the note.
      writeFileSync(join(dir, b), 'edited\n');
      const refused = await cli(dir, ['rm', b]);
      expect(refused.code).toBe(EXIT_FAILURE);
      expect(refused.stderr).toMatch(/uncommitted edits/);
      writeFileSync(join(dir, b), files.get(b) as string);

      const moved = b.replace(/\.md$/, '-moved.md');
      expect((await ok(dir, ['mv', b, moved, '-m', 'update rename'])).stdout).toBe(
        `renamed ${b} -> ${moved}\n`,
      );
      expect(existsSync(join(dir, b))).toBe(false);
      expect(readFileSync(join(dir, moved), 'utf8')).toBe(files.get(b));
      expect((await ok(dir, ['status', '--json'])).stdout).toContain('"behind": []');

      expect((await ok(dir, ['rm', moved, '-m', 'lint remove'])).stdout).toBe(`deleted ${moved}\n`);
      expect(existsSync(join(dir, moved))).toBe(false);
      const gone = await cli(dir, ['read', moved]);
      expect(gone.code).toBe(EXIT_FAILURE);
      expect(gone.stderr.trim().split('\n')).toHaveLength(1);

      // History follows the rename and shows the delete; restore brings it back.
      const history = await ok(dir, ['history', moved]);
      const lines = history.stdout.trim().split('\n');
      expect(lines[0]).toMatch(
        /^\d{4}-\d\d-\d\d \d\d:\d\d {2}[0-9a-f]{12} {2}\S+ {2}.*\(deleted\)$/,
      );
      expect(lines.some((l) => l.includes(`[${b}]`))).toBe(true);
      const json = JSON.parse((await ok(dir, ['history', moved, '--json'])).stdout) as {
        versions: { commit: string; hash: string | null; path: string }[];
      };
      const before = json.versions.find((v) => v.hash !== null && v.path === moved);
      expect(before).toBeDefined();
      const restored = await ok(dir, ['restore', moved, (before?.commit as string).slice(0, 12)]);
      expect(restored.stdout).toBe(`restored ${moved} to ${before?.commit.slice(0, 12)}\n`);
      expect(readFileSync(join(dir, moved), 'utf8')).toBe(files.get(b));
    });

    it('never sends or fetches excluded paths', async () => {
      const dir = newDir('excluded');
      await ok(tmp.dir, ['connect', server.url, 'garden', dir]);
      mkdirSync(join(dir, EXCLUDED_FOLDER), { recursive: true });
      writeFileSync(join(dir, EXCLUDED_FOLDER, 'secret.md'), 'invented private words\n');
      expect((await ok(dir, ['hot'])).stderr).toBe(''); // not pending: never sent
      const commit = await ok(dir, ['commit']);
      expect(commit.stdout).toContain('not sent: 1 new file in excluded folders');
      const read = await cli(dir, ['read', `${EXCLUDED_FOLDER}/secret.md`]);
      expect(read.code).toBe(EXIT_FAILURE);
      expect(read.stderr.trim().split('\n')).toHaveLength(1);
      expect(read.stderr).not.toContain('invented private words');
      expect(read.stderr).toMatch(/excluded/);
    });

    it('works from the environment alone, with no files', async () => {
      const cwd = newDir('bare');
      mkdirSync(cwd);
      const workdir = newDir('env-work');
      const env = envOnly({ SOMEMEMOS_WORKDIR: workdir });
      const l = await ok(work, ['hot']);
      const r = await ok(cwd, ['hot'], env);
      // Paths are shown brain-relative: the working folder is not where the agent is.
      expect(r.stdout).toBe(l.stdout);
      expect(existsSync(workdir)).toBe(false); // queries write nothing
      const path = memos[9] as string;
      expect((await ok(cwd, ['read', path], env)).stdout).toBe(files.get(path));
      writeFileSync(join(workdir, path), `${files.get(path)}\nFrom a bare session.\n`);
      expect((await ok(cwd, ['log', '--limit', '1'], env)).stderr).toMatch(
        /1 changed note not committed/,
      );
      expect((await ok(cwd, ['commit', '-m', 'session bare'], env)).stdout).toContain(
        `committed 1 note (session)`,
      );
      expect(existsSync(join(workdir, '.somememos', 'config.json'))).toBe(false);
      // Default working folder: ~/somememos/<brain id>.
      await ok(cwd, ['read', path], envOnly());
      expect(existsSync(join(home, 'somememos', 'garden', path))).toBe(true);

      // Paths are shown brain-relative there (the working folder is not where
      // the agent is), and read takes either form.
      const hot = (await ok(cwd, ['hot'], envOnly())).stdout;
      expect(hot).not.toContain(join(home, 'somememos'));
      expect(hot).toMatch(/^memos\//m);
      const found = (await ok(cwd, ['search', brain.topics[0]?.name as string], envOnly())).stdout;
      expect(found).not.toContain(home);
      expect(found).toMatch(/^memos\//m);
      expect(
        (await ok(cwd, ['read', join(home, 'somememos', 'garden', path)], envOnly())).stdout,
      ).toBe(readFileSync(join(home, 'somememos', 'garden', path), 'utf8'));
    });

    it('a wrong token and an unreachable server are one-line errors with exit 1', async () => {
      const wrong = await cli(work, ['hot'], { SOMEMEMOS_TOKEN: 'not-the-token-0123456789abcdef' });
      expect(wrong.code).toBe(EXIT_FAILURE);
      expect(wrong.stderr).toBe(
        'somememos hot: the server refused the token (check SOMEMEMOS_TOKEN or the token file)\n',
      );
      const none = await cli(work, ['hot'], { SOMEMEMOS_TOKEN: undefined });
      expect(none.code).toBe(EXIT_FAILURE);
      expect(none.stderr.trim().split('\n')).toHaveLength(1);
      expect(none.stderr).toMatch(/no token: set SOMEMEMOS_TOKEN/);

      const cwd = newDir('nowhere');
      mkdirSync(cwd);
      const closed = await closedPort();
      const unreachable = await cli(cwd, ['search', 'anything'], {
        SOMEMEMOS_SERVER: `http://127.0.0.1:${closed}`,
        SOMEMEMOS_BRAIN_ID: 'garden',
        SOMEMEMOS_WORKDIR: cwd,
      });
      expect(unreachable.code).toBe(EXIT_FAILURE);
      expect(unreachable.stderr).toBe(
        `somememos search: cannot reach the server at 127.0.0.1:${closed} (ECONNREFUSED)\n`,
      );
      const badConnect = await cli(tmp.dir, ['connect', server.url, 'garden', newDir('bad')], {
        SOMEMEMOS_TOKEN: 'not-the-token-0123456789abcdef',
      });
      expect(badConnect.code).toBe(EXIT_FAILURE);
      expect(badConnect.stderr).toMatch(/refused the token/);
      expect(existsSync(join(tmp.dir, 'bad', '.somememos'))).toBe(false);
      const noBrain = await cli(tmp.dir, ['connect', server.url, 'no-such-brain', newDir('nb')]);
      expect(noBrain.stderr).toBe('somememos connect: the server has no brain by that id\n');
    });

    describe('clone and sync', () => {
      it('clone copies the brain; local commands then work with the server stopped', async () => {
        const copy = newDir('clone-a');
        const cloned = await ok(tmp.dir, ['clone', server.url, 'garden', copy]);
        expect(cloned.stdout.split('\n')[0]).toBe(
          `cloned brain garden from ${server.url} into ${copy}`,
        );
        expect(existsSync(join(copy, '.somememos', 'remote.json'))).toBe(true);
        const path = memos[10] as string;
        expect(readFileSync(join(copy, path), 'utf8')).toBe(files.get(path));
        // The clone ranks like the server.
        expect((await ok(copy, ['hot'])).stdout).toBe((await ok(work, ['hot'])).stdout);

        await server.stop();
        try {
          expect((await ok(copy, ['search', brain.topics[0]?.name as string])).stdout).not.toBe('');
          expect((await ok(copy, ['read', path])).stdout).toBe(files.get(path));
          writeFileSync(join(copy, path), `${files.get(path)}\nWritten offline.\n`);
          await ok(copy, ['commit', '-m', 'update offline']);
          const status = await ok(copy, ['status']);
          expect(status.stdout).toMatch(/to push: 1 note, \d+ events?, 1 change record/);
          const offline = await cli(copy, ['sync']);
          expect(offline.code).toBe(EXIT_FAILURE);
          expect(offline.stderr).toMatch(/^somememos sync: cannot reach the server/);
        } finally {
          await server.start();
        }
        const synced = await ok(copy, ['sync']);
        expect(synced.stdout).toMatch(/pushed 1 edit \(1 applied\)/);
        expect((await ok(work, ['read', path])).stdout).toContain('Written offline.');
      });

      it('two clones editing different notes converge', async () => {
        const a = newDir('clone-b');
        const b = newDir('clone-c');
        await ok(tmp.dir, ['clone', server.url, 'garden', a]);
        await ok(tmp.dir, ['clone', server.url, 'garden', b]);
        const [p, q] = [memos[11] as string, memos[12] as string];
        writeFileSync(join(a, p), `${files.get(p)}\nFrom clone a.\n`);
        writeFileSync(join(b, q), `${files.get(q)}\nFrom clone b.\n`);
        mkdirSync(join(b, 'memos'), { recursive: true });
        writeFileSync(join(b, 'memos/from-b.md'), '# From b\n\nA new note.\n');
        await ok(a, ['commit', '-m', 'update a']);
        await ok(b, ['commit', '-m', 'update b']);
        await ok(a, ['read', q]);
        await ok(a, ['sync']);
        await ok(b, ['sync']);
        await ok(a, ['sync']);
        for (const path of [p, q, 'memos/from-b.md']) {
          expect(readFileSync(join(a, path), 'utf8')).toBe(readFileSync(join(b, path), 'utf8'));
        }
        expect(readFileSync(join(b, p), 'utf8')).toContain('From clone a.');
        const sa = await json<{ events: object; changes: number; notes: object }>(a, ['status']);
        const sb = await json<{ events: object; changes: number; notes: object }>(b, ['status']);
        expect(sb.events).toEqual(sa.events);
        expect(sb.changes).toBe(sa.changes);
        expect(sb.notes).toEqual(sa.notes);
        expect((await ok(b, ['hot', '--json'])).stdout).toBe(
          (await ok(a, ['hot', '--json'])).stdout,
        );
      });

      it('conflicting edits produce a conflict file and lose nothing', async () => {
        const a = newDir('clone-d');
        const b = newDir('clone-e');
        await ok(tmp.dir, ['clone', server.url, 'garden', a]);
        await ok(tmp.dir, ['clone', server.url, 'garden', b]);
        const p = memos[13] as string;
        writeFileSync(join(a, p), 'version from a\n');
        writeFileSync(join(b, p), 'version from b\n');
        await ok(a, ['sync']);
        const r = await ok(b, ['sync']);
        expect(r.stdout).toMatch(/1 conflict$/m);
        const warning = r.stderr.trim();
        expect(warning).toMatch(
          /^somememos: warning: conflict: .* now has the server's version; this copy's version is kept as \S+\.conflict-[^ ]+\.md;/,
        );
        expect(readFileSync(join(b, p), 'utf8')).toBe('version from a\n');
        const kept = filesUnder(join(b, 'memos')).find((f) => f.includes('.conflict-'));
        expect(kept && readFileSync(kept, 'utf8')).toBe('version from b\n');
        // The conflict file reaches the other copy too.
        await ok(a, ['sync']);
        expect(filesUnder(join(a, 'memos')).some((f) => f.includes('.conflict-'))).toBe(true);
      });

      it('the shared config syncs between clones; a conflict stops sync until pull or push', async () => {
        await server.createBrain('roles', ROLES);
        const a = newDir('roles-a');
        const b = newDir('roles-b');
        await ok(tmp.dir, ['clone', server.url, 'roles', a]);
        mkdirSync(join(a, 'memos/hush'), { recursive: true });
        writeFileSync(join(a, 'memos/hush/pond.md'), '# Pond\n\nheron reeds\n');
        await ok(a, ['commit', '-m', 'a note']);
        await ok(a, ['sync']);
        await ok(tmp.dir, ['clone', server.url, 'roles', b]);
        expect(readFileSync(join(b, 'memos/hush/pond.md'), 'utf8')).toContain('heron');

        const shown = await json<{ source: string; state: string; revision: number }>(a, [
          'config',
        ]);
        expect(shown).toMatchObject({ source: 'copy', state: 'in-step', revision: 1 });

        // Edit config.json in clone a: the next command re-indexes, sync sends it.
        const configFile = join(a, '.somememos', 'config.json');
        const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
          roles: Record<string, string[]>;
        };
        config.roles.excluded = [...(config.roles.excluded ?? []), 'memos/hush/'];
        writeFileSync(configFile, JSON.stringify(config));
        expect((await ok(a, ['search', 'heron'])).stdout).toBe('');
        expect((await json<{ state: string }>(a, ['config'])).state).toBe('changed-here');
        expect((await ok(a, ['sync'])).stdout).toMatch(/sent this copy’s shared config/);
        // Nothing deleted, and the working folder of remote mode reads the server's config.
        expect(existsSync(join(a, 'memos/hush/pond.md'))).toBe(true);
        const remoteView = await json<{ source: string; revision: number }>(work, ['config']);
        expect(remoteView.source).toBe('server');

        const pulled = await ok(b, ['sync']);
        expect(pulled.stdout).toMatch(/took the server’s shared config/);
        expect(
          (JSON.parse(readFileSync(join(b, '.somememos', 'config.json'), 'utf8')) as typeof config)
            .roles.excluded,
        ).toContain('memos/hush/');
        expect((await ok(b, ['search', 'heron'])).stdout).toBe('');
        expect(existsSync(join(b, 'memos/hush/pond.md'))).toBe(true);

        // Both change it: the second sync refuses, and push keeps b's.
        const edit = (dir: string, blog: string[]) => {
          const file = join(dir, '.somememos', 'config.json');
          const c = JSON.parse(readFileSync(file, 'utf8')) as typeof config;
          c.roles.blog = blog;
          writeFileSync(file, JSON.stringify(c));
        };
        edit(a, ['posts/']);
        edit(b, ['journal/']);
        await ok(a, ['sync']);
        const refused = await cli(b, ['sync']);
        expect(refused.code).toBe(EXIT_FAILURE);
        expect(refused.stderr).toMatch(/changed both in this copy and on the server/);
        expect((await json<{ state: string }>(b, ['config'])).state).toBe('both-changed');
        await ok(b, ['config', 'push']);
        await ok(a, ['sync']);
        const blogOf = (dir: string) =>
          (
            JSON.parse(
              readFileSync(join(dir, '.somememos', 'config.json'), 'utf8'),
            ) as typeof config
          ).roles.blog;
        expect(blogOf(a)).toEqual(['journal/']);
        // And pull takes the server's.
        edit(a, ['diary-posts/']);
        edit(b, ['other/']);
        await ok(a, ['sync']);
        expect((await cli(b, ['sync'])).code).toBe(EXIT_FAILURE);
        await ok(b, ['config', 'pull']);
        expect(blogOf(b)).toEqual(['diary-posts/']);
        await ok(b, ['sync']);
      });

      it('history and restore work in a clone, and restore updates the copy', async () => {
        const copy = newDir('clone-history');
        await ok(tmp.dir, ['clone', server.url, 'garden', copy]);
        writeFileSync(join(copy, 'memos/lantern.md'), '# Lantern\n\nfirst wording\n');
        await ok(copy, ['commit', '-m', 'ingest lantern']);
        await ok(copy, ['sync']);
        writeFileSync(join(copy, 'memos/lantern.md'), '# Lantern\n\nsecond wording\n');
        await ok(copy, ['commit', '-m', 'update lantern']);
        await ok(copy, ['sync']);

        const history = await json<{ versions: { commit: string; message: string }[] }>(copy, [
          'history',
          'memos/lantern.md',
        ]);
        expect(history.versions.map((v) => v.message)).toEqual([
          'update lantern',
          'ingest lantern',
        ]);
        const first = (history.versions[1] as { commit: string }).commit;
        const restored = await ok(copy, ['restore', 'memos/lantern.md', first.slice(0, 10)]);
        expect(restored.stdout).toBe(`restored memos/lantern.md to ${first.slice(0, 12)}\n`);
        expect(readFileSync(join(copy, 'memos/lantern.md'), 'utf8')).toBe(
          '# Lantern\n\nfirst wording\n',
        );
        expect((await ok(work, ['read', 'memos/lantern.md'])).stdout).toContain('first wording');
        expect((await ok(copy, ['sync'])).stdout).toMatch(/pushed 0 edits/);

        // Offline: one clear line.
        await server.stop();
        try {
          const offline = await cli(copy, ['history', 'memos/lantern.md']);
          expect(offline.code).toBe(EXIT_FAILURE);
          expect(offline.stderr).toMatch(
            /^somememos history: history needs the server, which can't be reached now/,
          );
          const restoreOffline = await cli(copy, ['restore', 'memos/lantern.md', first]);
          expect(restoreOffline.code).toBe(EXIT_FAILURE);
          expect(restoreOffline.stderr).toMatch(/restore needs the server, which can't be reached/);
        } finally {
          await server.start();
        }
        // A local brain with no server still says what it needs.
        const plain = newDir('plain-history');
        await ok(tmp.dir, ['init', plain]);
        const none = await cli(plain, ['history', 'memos/x.md']);
        expect(none.stderr).toMatch(/history needs a server/);
      });

      it('sync names the notes too large to sync, which stay in the copy', async () => {
        const copy = newDir('clone-big');
        await ok(tmp.dir, ['clone', server.url, 'garden', copy]);
        writeFileSync(join(copy, 'memos/huge.md'), `# Huge\n\n${'y'.repeat(2 * 1024 * 1024)}\n`);
        await ok(copy, ['commit', '-m', 'ingest a huge note']);
        const r = await ok(copy, ['sync']);
        expect(r.stderr).toMatch(
          /warning: 1 note too large to sync \(over 2 MB\) stays in this copy only: memos\/huge\.md; split it to sync/,
        );
        const record = await json<{ tooLarge: string[] }>(copy, ['sync']);
        expect(record.tooLarge).toEqual(['memos/huge.md']);
        expect(existsSync(join(copy, 'memos/huge.md'))).toBe(true);
        rmSync(join(copy, 'memos/huge.md'));
      });

      it('sync keeps a note named like a folder on the server, and does not loop', async () => {
        const one = newDir('clone-clash-1');
        const two = newDir('clone-clash-2');
        await ok(tmp.dir, ['clone', server.url, 'garden', one]);
        await ok(tmp.dir, ['clone', server.url, 'garden', two]);
        mkdirSync(join(one, 'memos/willow.md'), { recursive: true });
        writeFileSync(join(one, 'memos/willow.md/catkin.md'), '# Catkin\n');
        await ok(one, ['commit', '-m', 'ingest catkin']);
        await ok(one, ['sync']);
        // The other copy makes a note of that name before it has pulled the folder.
        writeFileSync(join(two, 'memos/willow.md'), '# Willow\n');
        await ok(two, ['commit', '-m', 'ingest willow']);
        const r = await ok(two, ['sync']);
        expect(r.stderr).toMatch(
          /warning: 1 note shares its name with a folder on the server, so it stays in this copy only: memos\/willow\.md; rename it to sync/,
        );
        for (let i = 0; i < 3; i++) {
          const again = await json<{ nameClash: string[]; conflicts: unknown[]; rounds: number }>(
            two,
            ['sync'],
          );
          expect(again.nameClash).toEqual(['memos/willow.md']);
          expect(again.conflicts).toEqual([]);
          expect(again.rounds).toBe(1);
        }
        expect(readFileSync(join(two, 'memos/willow.md'), 'utf8')).toBe('# Willow\n');
        rmSync(join(two, 'memos/willow.md'));
        rmSync(join(one, 'memos/willow.md'), { recursive: true });
        await ok(one, ['commit', '-m', 'remove catkin']);
        await ok(one, ['sync']);
        await ok(two, ['sync']);
      });

      it('sync in a brain with no server says how to set one', async () => {
        const dir = newDir('plain');
        await ok(tmp.dir, ['init', dir]);
        const r = await cli(dir, ['sync']);
        expect(r.code).toBe(EXIT_FAILURE);
        expect(r.stderr).toMatch(
          /no server to sync with: make an offline copy with 'somememos clone/,
        );
      });
    });

    it('the token appears in no output, file or error', () => {
      expect(outputs.length).toBeGreaterThan(50);
      for (const text of outputs) expect(text.includes(TEST_TOKEN)).toBe(false);
      let checked = 0;
      for (const dir of folders) {
        for (const file of filesUnder(dir)) {
          expect(readFileSync(file).includes(TEST_TOKEN), file).toBe(false);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(100);
    });

    function envOnly(extra: Record<string, string> = {}) {
      return {
        SOMEMEMOS_SERVER: server.url,
        SOMEMEMOS_BRAIN_ID: 'garden',
        ...extra,
      };
    }
    // Each test drives dozens of CLI runs (local ones with an index pass,
    // remote ones over HTTP to a server on Postgres): a few seconds idle, more
    // than the default 5 s on a loaded machine.
  },
  { timeout: 60_000 },
);
