# Questions for Mike

Collected while Mike was away overnight (from 2026-11-27). None of these blocked the work: each lists the choice made in the meantime, which is easy to change.

1. **Railway.** Deploying needs a Railway project connected to this repository, a Postgres database and a volume. **Done 2026-11-27:** deployed at https://web-production-04386931.up.railway.app, deploying from `main` after CI passes (docs/deploy.md). Still yours: a custom domain, scheduling volume backups, and creating the first brain.

2. **Sign-in.** How should you sign in to your own server: a passkey, a magic link by email, or sign-in with GitHub or Google?
   - *Meanwhile:* a single-user access token set in the server's environment, which is enough for one person and for agents. Real sign-in can replace it without changing the sync protocol.

3. **Renaming `wiki/` to `memos/` in your vault.** This session only has read access to `mckoss/2nd-brain`.
   - *Meanwhile:* experiments on the vault map `wiki/**` to the memo role in a local config, which needs no rename.

4. **Diary path for new brains.** `diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md`, the same shape as your vault.
   - *Meanwhile:* that is the default.

5. **Git import and side branches.** The import follows the main line of history, so work on a branch merged without squashing is dated at the merge.
   - *Meanwhile:* left as is.

6. **Docker image.** The `Dockerfile` for Railway was written but never built, because this environment has no Docker daemon. **Done 2026-11-27:** Railway built and started it unchanged.
   - *Meanwhile:* the server was run and tested directly with Node and a local Postgres.

7. **Safari on iOS and Firefox.** Only Chromium is available here, so the web app's on-device storage is untested in other browsers. It should work on Safari 16.4 or later and Firefox 114 or later.
   - *Meanwhile:* the app falls back to in-memory storage, with a visible warning, wherever on-device storage is unavailable.

8. **Blog images and attachments.** Public pages show a post's text only; images and attached files are not served.
   - *Meanwhile:* an image shows its alt text. Decide whether attachments should be served, and from where.

9. **Blog addresses after a rename.** Renaming a post makes its old address return 404, because there is no redirect table.
   - *Meanwhile:* left as is. Say if old addresses should redirect.

10. **Listing blogs in `robots.txt`.** It lists the sitemap of every enabled blog, which lets anyone see which blogs exist on the server.
    - *Meanwhile:* left as is, since blogs are meant to be found.

11. **Time in caches after unpublishing.** A page can stay in a browser or proxy cache for up to a minute after its post is unpublished.
    - *Meanwhile:* one minute. It can be shorter at the cost of more requests.

12. **Folder roles across devices.** Settled overnight: a brain's shared settings, roles included, now sync, and two devices that both changed them get a choice, never a silent overwrite. Excluding a folder never deletes its notes anywhere.
    - *Still yours to decide:* should a newly excluded folder's notes ever be removed from the server's repository? Today they never are.

13. **Blog settings screen.** Settled overnight: the app has a Public blog section in More.

14. **Security review follow-ups** (`docs/security-review-2026-11-27.md`). Nothing critical or high is open. Left for you:
    - Should images in notes be limited to the app's own site? Today a note can load an image from any https site, which tells that site when you open the note.
    - The contact line in `SECURITY.md` is a placeholder.
    - Whether to add a strict-transport-security header once the domain is settled.

15. **Exporting notes from the web app.** Settled overnight: "Export everything" writes a zip of every note plus the event log, and the import screen reads it back.

16. **Smaller choices made in the last pass,** each easy to change:
    - The CLI refuses plain `http` servers except on this machine. Should `--allow-insecure` be remembered for a working folder, so it needn't be passed every time?
    - Public blog pages drop HTML comments. Should they also drop Obsidian-style `%% ... %%` comments?
    - The lockout finding from the security review is fixed by slowing failed attempts and never refusing a valid token.

17. **The sync test that failed once on CI.** Its exact cause was never reproduced. A real bug with the same symptom was fixed (the note page could stay on "No note here yet"), and the tests now explain themselves when they fail. Treat it as probably fixed until CI has stayed green for a while.

18. **The CLI on Node 22.** Everything needs Node 26 except the CLI, which still supports Node 22.13 or later so agents can use it where Node 22 is what's installed.
    - *Meanwhile:* a CI job on Node 22 proves it. Node 22 leaves maintenance in April 2027; drop that job and require Node 26 for the CLI then, or sooner if you prefer one version everywhere.

19. **Zip export limits.** The three bespoke pieces are now packages (v0.6.2). One trade-off is yours: `fflate` is fast (20,000 notes export in about 4 seconds) but cannot write archives over 65,535 files or 4 GB, and does not keep each note's modified time on import. The alternative library tried, `zip.js`, has no such limits but took 13 seconds to write and about 30 to read the same brain, and used far more memory.
    - *Meanwhile:* `fflate`, with a plain refusal past the limits and notes dated at import time.

