# V1.0 Features

- Add check command to look for filename case problems.
X Build file mapping for normalized file names.
- Add fix command to fix all the checked errors.
- renmae files (git compatible)
- Check for non-ascii characters in files
X setup install static files
- add code coverage
- log files
- Full docs See markdown pypi docs for example!
- Use markdown extensions
- Put sample markdown file in default theme content

- tags
- Summary sections (based on tag and date queries)
- Commit hook from github
- Host somememos at Amazon
  - Version to use host headers - match github repo name (first come first served).
  - Directory of recently updated repos on somememos.com.
  - Pull themes from external github repo
  - Render 'staging' branch for testing (as opposed to master).
X Render raw pages
X Content type
X Static content within content space - use file extension to differentiate processing.
- Plugins within MarkDown
X 301 redirect path canonicalization
  - Remove file extensions .htm, .html
  - mixed-case paths -> lower case
  - Turn camel-case paths to hyphen puntuated paths
X Render Markdown.
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
- Automatic Image thumbnails
- Mobile (or progressive) rendering.
- Extensions
  - Widgets
  - Themes
- Code coloring plugin
- RSS or Atom
- JS and CSS combination (hash-based naming - long expires)
- Multi-site host (with shared resources (templates, static files))
- nginx integration/documentation
- index page enumeration of child pages
- directory-based templates
- Watch for filesytem changes to reset caches
- Page editing interface
  - Google/Facebook/Twitter/Email user login
