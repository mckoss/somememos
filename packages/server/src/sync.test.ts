// Sync between simulated offline copies (core's engine on in-memory stores,
// the same client code the web app runs) and the server, through the real
// HTTP handler, against Postgres and a git repository. All content invented.

import { join } from 'node:path';
import { createRng, generateBrain } from '@somememos/core/testing/brain';
import { expectScoresClose } from '@somememos/core/testing/storage';
import { createPgStores } from '@somememos/pg-store';
import { expect, it } from 'vitest';
import { createGitContentStore } from './git-content.js';
import { runGit } from './git.js';
import {
  type TestClient,
  type TestServer,
  T0,
  clock,
  createBrain,
  describePg,
  testClient,
  testServer,
} from './test-env.testing.js';

const TIMEOUT = 120_000;
/** Seeds for the convergence property; `SOMEMEMOS_SYNC_SEEDS=1-40` runs more. */
const SEEDS = ((spec) => {
  const m = /^(\d+)-(\d+)$/.exec(spec ?? '');
  if (!m) return [1, 2, 3, 4, 5, 6];
  const out: number[] = [];
  for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
  return out;
})(process.env.SOMEMEMOS_SYNC_SEEDS);

async function serverState(server: TestServer, brainId: string) {
  const content = createGitContentStore(join(server.dataDir, 'brains', brainId));
  const notes: Record<string, string> = {};
  for (const e of (await content.list()).sort((a, b) => (a.path < b.path ? -1 : 1))) {
    notes[e.path] = (await content.read(e.path)) as string;
  }
  const stores = await createPgStores({ pool: server.pool, brainId, now: server.now });
  const events = (await stores.events.readAfter(0)).map((e) => e.id).sort();
  const changes = (await stores.events.changes()).map((c) => c.id).sort();
  const scores = await stores.scores.getAll();
  return { notes, events, changes, scores };
}

async function clientState(c: TestClient) {
  const events = (await c.stores.events.readAfter(0)).map((e) => e.id).sort();
  const changes = (await c.stores.events.changes()).map((x) => x.id).sort();
  return { notes: c.content.snapshot(), events, changes, scores: await c.stores.scores.getAll() };
}

async function expectConverged(server: TestServer, brainId: string, clients: TestClient[]) {
  const s = await serverState(server, brainId);
  for (const c of clients) {
    const mine = await clientState(c);
    expect(mine.notes, `${c.id}: notes`).toEqual(s.notes);
    expect(mine.events, `${c.id}: event ids`).toEqual(s.events);
    expect(mine.changes, `${c.id}: change ids`).toEqual(s.changes);
    expectScoresClose(mine.scores, s.scores);
    // The derived index agrees with the content.
    expect((await c.engine.noteTitles()).map((t) => t.path)).toEqual(Object.keys(s.notes).sort());
  }
  return s;
}

describePg('sync', () => {
  it(
    'uploads a brain that started on a client, then a first sync downloads it',
    { timeout: TIMEOUT },
    async () => {
      const server = await testServer();
      await createBrain(server, 'garden');
      const a = testClient(server, 'garden', 'phone');
      await a.engine.index();
      // A brain made on the device: notes, links, a rename, a delete, reads.
      const synthetic = generateBrain({ seed: 3, steps: 20 });
      for (const step of synthetic.steps.slice(0, 12)) {
        server.now.set(step.time);
        for (const change of step.changes) {
          if (change.type === 'write') {
            if (change.path.startsWith('private/')) continue;
            const r = await a.engine.saveNote(change.path, change.content, {
              message: step.message,
            });
            expect(['saved', 'unchanged']).toContain(r.status);
          }
        }
      }
      server.now.tick(3600);
      const memos = (await a.engine.noteTitles()).filter((t) => t.role === 'memo');
      await a.engine.readNote(memos[0]?.path as string);
      await a.engine.renameNote(memos[1]?.path as string, 'memos/renamed-on-phone.md', {
        message: 'update rename',
      });
      await a.engine.deleteNote(memos[2]?.path as string, { message: 'lint drop' });
      const before = await clientState(a);
      expect(before.events.length).toBeGreaterThan(10);

      server.now.tick();
      const up = await a.sync();
      expect(up.conflicts).toEqual([]);
      // The server logged nothing of its own: exactly the phone's entries.
      const s = await expectConverged(server, 'garden', [a]);
      expect(s.events).toEqual(before.events);
      expect((await a.engine.syncStatus()).pending).toEqual({ notes: 0, events: 0, changes: 0 });

      // A new, empty copy downloads everything.
      const b = testClient(server, 'garden', 'laptop');
      const down = await b.sync();
      expect(down.conflicts).toEqual([]);
      await expectConverged(server, 'garden', [a, b]);
      // Nothing to push afterwards: what arrived is not a local change.
      const next = await b.engine.prepareSync();
      expect(next.request.edits).toEqual([]);
      expect(next.request.events).toEqual([]);
      expect(next.request.changes).toEqual([]);
      expect((await b.engine.status()).uncommitted).toEqual([]);

      // Each accepted change set is one git commit, authored by the phone.
      const dir = join(server.dataDir, 'brains', 'garden');
      const authors = (await runGit(dir, ['log', '--format=%an'])).trim().split('\n');
      expect(new Set(authors)).toEqual(new Set(['phone']));
      const messages = (await runGit(dir, ['log', '--format=%s'])).trim().split('\n');
      expect(messages).toContain('update rename');
    },
  );

  it('counts nothing twice when a request is repeated', { timeout: TIMEOUT }, async () => {
    const server = await testServer();
    await createBrain(server, 'retry');
    const a = testClient(server, 'retry', 'phone');
    await a.engine.index();
    server.now.tick();
    await a.engine.saveNote('memos/lamp.md', '# Lamp\n\nSee [[wick]].\n', {
      message: 'ingest lamp',
    });
    await a.engine.readNote('memos/lamp.md');
    const prepared = await a.engine.prepareSync();
    const first = await a.send(prepared.request);
    expect(first.results.map((r) => r.status)).toEqual(['applied']);
    const afterFirst = await serverState(server, 'retry');
    const counter = (await server.request('GET', '/api/brains/retry')).body.mutation;
    // The response was lost; the same request again.
    const second = await a.send(prepared.request);
    expect(second.results.map((r) => r.status)).toEqual(['duplicate']);
    expect(second.results[0]?.hash).toBe(first.results[0]?.hash);
    expect((await server.request('GET', '/api/brains/retry')).body.mutation).toBe(counter);
    const afterSecond = await serverState(server, 'retry');
    expect(afterSecond.events).toEqual(afterFirst.events);
    expect(afterSecond.changes).toEqual(afterFirst.changes);
    expectScoresClose(afterSecond.scores, afterFirst.scores);
    await a.engine.applySync(prepared, second);
    // And applying a response twice adds nothing on the client either.
    await a.engine.applySync(prepared, second);
    await expectConverged(server, 'retry', [a]);
    const dir = join(server.dataDir, 'brains', 'retry');
    expect((await runGit(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
  });

  it(
    'keeps a stale edit as a conflict file; nothing is lost and all copies converge',
    { timeout: TIMEOUT },
    async () => {
      const server = await testServer();
      await createBrain(server, 'clash');
      const a = testClient(server, 'clash', 'phone');
      const b = testClient(server, 'clash', 'laptop');
      await a.engine.index();
      await a.engine.saveNote('memos/plan.md', '# Plan\n\nv1\n');
      await a.sync();
      await b.sync();
      server.now.tick();
      await a.engine.saveNote('memos/plan.md', '# Plan\n\nphone version\n', {
        message: 'update from phone',
      });
      await b.engine.saveNote('memos/plan.md', '# Plan\n\nlaptop version\n', {
        message: 'update from laptop',
      });
      expect((await a.sync()).conflicts).toEqual([]);
      const stale = await b.engine.prepareSync();
      const response = await b.send(stale.request);
      expect(response.results[0]).toMatchObject({
        status: 'conflict',
        currentText: '# Plan\n\nphone version\n',
      });
      const outcome = await b.engine.applySync(stale, response);
      expect(outcome.conflicts).toHaveLength(1);
      const kept = outcome.conflicts[0]?.conflictPath as string;
      expect(kept).toMatch(/^memos\/plan\.conflict-laptop-\d{4}-\d{2}-\d{2}\.md$/);
      expect(await b.content.read(kept)).toBe('# Plan\n\nlaptop version\n');
      expect(await b.content.read('memos/plan.md')).toBe('# Plan\n\nphone version\n');
      await b.sync();
      await a.sync();
      const s = await expectConverged(server, 'clash', [a, b]);
      expect(s.notes[kept]).toBe('# Plan\n\nlaptop version\n');
      expect(s.notes['memos/plan.md']).toBe('# Plan\n\nphone version\n');
      // Both edits' events are kept: each copy logged its own.
      const edits = (await a.stores.events.readAfter(0)).filter(
        (e) => e.kind === 'edit' && e.item === 'memos/plan.md',
      );
      expect(new Set(edits.map((e) => e.client))).toEqual(new Set(['phone', 'laptop']));
    },
  );

  it('pages a large download', { timeout: TIMEOUT }, async () => {
    const server = await testServer({ pageSize: 10 });
    await createBrain(server, 'big');
    const a = testClient(server, 'big', 'phone');
    await a.engine.index();
    for (let i = 0; i < 30; i++) {
      server.now.tick();
      await a.engine.saveNote(`memos/n${i}.md`, `# N${i}\n\n[[n${i + 1}]] quartz ${i}\n`);
    }
    const up = await a.sync({ maxEdits: 7, maxEvents: 13, maxChanges: 5 });
    expect(up.rounds).toBeGreaterThan(3);
    const b = testClient(server, 'big', 'laptop');
    const down = await b.sync();
    expect(down.rounds).toBeGreaterThan(5);
    expect(down.outcomes.slice(0, -1).every((o) => o.more)).toBe(true);
    await expectConverged(server, 'big', [a, b]);
  });

  it(
    'logs events for server-side saves through the engine routes, which then sync',
    { timeout: TIMEOUT },
    async () => {
      const server = await testServer();
      await createBrain(server, 'agent');
      const a = testClient(server, 'agent', 'phone');
      await a.engine.index();
      await a.engine.saveNote('memos/topic.md', '# Topic\n');
      await a.sync();
      server.now.tick();
      const saved = await server.request(
        'PUT',
        '/api/brains/agent/notes/memos/agent-notes.md',
        {
          text: '# Agent notes\n\nAbout [[topic]] and [[unwritten idea]].\n',
          baseHash: null,
          message: 'session notes',
        },
        { headers: { 'x-somememos-client': 'agent-cli' } },
      );
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ status: 'saved', created: true });
      const read = await server.request(
        'GET',
        '/api/brains/agent/notes/memos/topic.md',
        undefined,
        {
          headers: { 'x-somememos-client': 'agent-cli' },
        },
      );
      expect(read.body).toMatchObject({ recorded: true, backlinks: ['memos/agent-notes.md'] });
      const s = await serverState(server, 'agent');
      const stores = await createPgStores({ pool: server.pool, brainId: 'agent', now: server.now });
      const logged = (await stores.events.readAfter(0)).filter((e) => e.client === 'agent-cli');
      expect(logged.map((e) => `${e.kind} ${e.item}`).sort()).toEqual([
        'edit memos/agent-notes.md',
        'mention memos/topic.md',
        'mention unwritten idea',
        'read memos/topic.md',
      ]);
      const dir = join(server.dataDir, 'brains', 'agent');
      expect((await runGit(dir, ['log', '-1', '--format=%an|%s'])).trim()).toBe(
        'agent-cli|session notes',
      );
      await a.sync();
      await expectConverged(server, 'agent', [a]);
      expect(s.events.length).toBe((await a.stores.events.readAfter(0)).length);
      // The phone counted nothing extra for what arrived.
      expect((await a.stores.events.readAfter(0)).filter((e) => e.client === 'phone')).toHaveLength(
        1,
      );
    },
  );

  it.each(SEEDS)(
    'converges after random offline edits, creates, renames and deletes (seed %i)',
    { timeout: TIMEOUT },
    async (seed) => {
      const rng = createRng(seed);
      const now = clock(T0);
      const server = await testServer({ now });
      await createBrain(server, `prop-${seed}`);
      const clients = [
        testClient(server, `prop-${seed}`, 'phone', now),
        testClient(server, `prop-${seed}`, 'laptop', now),
      ];
      for (const c of clients) await c.engine.index();
      const words = ['amber', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'garnet', 'heron'];
      let made = 0;
      const notesOf = async (c: TestClient) =>
        (await c.engine.noteTitles()).filter((t) => t.path.startsWith('memos/')).map((t) => t.path);
      for (let step = 0; step < 40; step++) {
        now.tick(rng.int(30, 4000));
        const c = rng.pick(clients);
        const existing = await notesOf(c);
        const roll = rng.next();
        if (roll < 0.15) {
          await c.sync();
        } else if (roll < 0.4 || existing.length === 0) {
          const name = `n${made++}`;
          const link = rng.chance(0.6)
            ? ` [[${rng.pick(words)}]] [[n${rng.int(0, made + 2)}]]`
            : '';
          await c.engine.saveNote(`memos/${name}.md`, `# ${name}\n\n${rng.pick(words)}${link}\n`, {
            message: `ingest ${name}`,
          });
        } else if (roll < 0.65) {
          const path = rng.pick(existing);
          const text = (await c.content.read(path)) as string;
          await c.engine.saveNote(path, `${text}${rng.pick(words)} [[${rng.pick(words)}]]\n`, {
            message: 'update more',
          });
        } else if (roll < 0.75) {
          const from = rng.pick(existing);
          const to = `memos/r${made++}.md`;
          await c.engine.renameNote(from, to, { message: 'update rename' });
        } else if (roll < 0.83) {
          await c.engine.deleteNote(rng.pick(existing), { message: 'lint drop' });
        } else {
          await c.engine.readNote(rng.pick(existing));
        }
      }
      // Every copy syncs twice with no further edits.
      for (let round = 0; round < 2; round++) {
        for (const c of clients) {
          now.tick();
          await c.sync();
        }
      }
      await expectConverged(server, `prop-${seed}`, clients);
    },
  );
});
