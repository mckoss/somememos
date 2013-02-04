# V1.0 Features

- Add check command to look for filename case problems.
- Add fix command to fix all the checked errors.
- setup install static files

X Render raw pages
X Content type
- Static content within content space - use file extension to differentiate processing.
- Plugins within MarkDown
- 301 redirect path canonicalization
  - Remove file extensions .htm, .html
  - mixed-case paths -> lower case
  - Turn camel-case paths to hyphen puntuated paths
- Render Markdown.
- Site templates.
- Multi-part files -> or add extensions within MarkDown file.
- Front matter (cf Jekyll standards).
  - Page title.
  - Author links (cf Google spec)
- somememos.conf
  - Google Analytics
  - Site Title (combne with page titles).
  - Disqus
- Memcache
- Admin support
  - Rsync to host and restart server
- Image thumbnails
- Mobile (or progressive) rendering.
- Extensions
  - Widgets
  - Themes
- Code coloring
- RSS or Atom
- JS and CSS combination (hash-based naming - long expires)
- Multi-site host (with shared resources (templates, static files))
- nginx integration/documentation
