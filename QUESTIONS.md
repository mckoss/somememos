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

6. **Docker image.** The `Dockerfile` for Railway was written but never built, because this environment has no Docker daemon. Expect to fix small things on the first real build.
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

12. **Folder roles across devices.** Roles are set when a brain is created on the server. Changing them later on one device is not pushed to the server or to other devices.
    - *Meanwhile:* the app warns that the change applies to that device only. Decide whether roles should be editable on the server and pushed out.

13. **Blog settings screen.** Turning a blog on and naming it is done through the API for now; the app has no screen for it.
    - *Meanwhile:* the routes are described in PLAN.md section 8.

