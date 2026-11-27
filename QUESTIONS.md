# Questions for Mike

Collected while Mike was away overnight (from 2026-11-27). None of these blocked the work: each lists the choice made in the meantime, which is easy to change.

1. **Railway.** Deploying needs a Railway project connected to this repository, a Postgres database and a volume. That is yours to create.
   - *Meanwhile:* the server is built and tested locally and in CI, with deployment notes, but not deployed.

2. **Sign-in.** How should you sign in to your own server: a passkey, a magic link by email, or sign-in with GitHub or Google?
   - *Meanwhile:* a single-user access token set in the server's environment, which is enough for one person and for agents. Real sign-in can replace it without changing the sync protocol.

3. **Renaming `wiki/` to `memos/` in your vault.** This session only has read access to `mckoss/2nd-brain`.
   - *Meanwhile:* experiments on the vault map `wiki/**` to the memo role in a local config, which needs no rename.

4. **Diary path for new brains.** `diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md`, the same shape as your vault.
   - *Meanwhile:* that is the default.

5. **Git import and side branches.** The import follows the main line of history, so work on a branch merged without squashing is dated at the merge.
   - *Meanwhile:* left as is.
