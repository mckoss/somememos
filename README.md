# SomeMemoS

A web server to serve a template-based web site where all the files defining the site pages
are designed to be placed under source control (i.e., defined by static files in the file system).

_This software is **not** ready for human consumption._

In some ways, this server shares some design goals with [Jekyll][], whose content is described completely
by static files (content files and template files).  The difference being that the SomeMemoS server
generates the web site dynamically, rather that creating a static version of the site.

SomeMemoS makes exensive use of [MarkDown][] for content editing and [Tornado][] for template file definition.  The
basic structure of a SomeMemoS file directory is:

    site-directory
        index.md
        misc.md
        raw-html.html
        img
            favico.ico
            misc.jpg
        css
            extra.css
        js
            extra.js
        templates
            local.html

It is assumed that all file and directory names in a SomeMemoS file sructure are lower case.  Run the check command
to test if you have any unreachable files in your site.

    $ somememos check-files [directory]

  [Jekyll]: https://github.com/mojombo/jekyll
  [MarkDown]: http://daringfireball.net/projects/markdown/
  [Tornado]: http://www.tornadoweb.org/


# Installation (via pip)

Most simply:

    $ pip install somememos

If you want to create a virtual (python) environment for your installation:

    $ virtualenv env
    $ source env/bin/activate
    $ pip install somememos


# Start SomeMemoS site server

    $ cd <site-directory>
    $ somememos

or

    $ somememos run-server <site-directory>


# Clone and install from source (creates virtualenv):

    $ git clone git@github.com:mckoss/somememos.git
    $ cd somememos
    $ source bin/use
