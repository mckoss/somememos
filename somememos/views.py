import os
import re
from datetime import datetime
import mimetypes

from markdown import markdown
from tornado.web import RequestHandler, StaticFileHandler, HTTPError

from util import Struct, parse_path


INDEX_NAME = 'index'


FORMATTERS = {
    "md": Struct(format=markdown),
    "html": Struct(format=lambda x: x),
    }


reg_camel = re.compile(r"[a-z][A-Z]")


class PageRequestHandler(RequestHandler):
    def initialize(self, search_path=None, site_data=None, **kwargs):
        super(PageRequestHandler, self).initialize(**kwargs)
        self.search_path = search_path
        self.site_data = site_data

    def get(self, path):
        normal_path = self.normalize_path(path, remove_extensions=FORMATTERS.keys())
        if normal_path != path:
            self.redirect('/' + normal_path, permanent=True)
            return
        full_path = self.search_path.find_file(path, INDEX_NAME)
        if full_path is None:
            raise HTTPError(404)
        (path, filename, extension) = parse_path(full_path)

        with open(full_path, "rb") as content_file:
            content = content_file.read()

        if extension not in FORMATTERS:
            mime_type = mimetypes.guess_type(full_path)[0]
            if mime_type:
                self.set_header("Content-Type", mime_type)
            self.finish(content)
            return

        content = FORMATTERS[extension].format(content)

        page_data = Struct(title=path)

        self.render('page.html', content=content, site=self.site_data, page=page_data)

    @staticmethod
    def normalize_path(path, remove_extensions=None):
        """
        Ensure all lower case, remove file extension, convert camel case to hyphenated.

        >>> P = PageRequestHandler
        >>> P.normalize_path('ABC')
        'abc'
        >>> P.normalize_path('camelCase')
        'camel-case'
        >>> P.normalize_path('a/b/test.txt')
        'a/b/test.txt'
        >>> P.normalize_path('a/b/test.md', ['md'])
        'a/b/test'
        >>> P.normalize_path('a/index')
        'a/'
        >>> P.normalize_path('index')
        ''
        """
        def hyphenate(match):
            pair = match.group(0)
            pair = pair.lower()
            return pair[0] + '-' + pair[1]

        path = reg_camel.sub(hyphenate, path).lower()
        if len(path) == 0 or path[-1] == '/':
            return path

        (path, filename, extension) = parse_path(path)
        result = path + '/' + filename if len(path) > 0 else filename
        if extension != '' and (remove_extensions is None or extension not in remove_extensions):
            result += '.' + extension
        if result.endswith('/' + INDEX_NAME) or result == INDEX_NAME:
            result = result[:-len(INDEX_NAME)]
        return result


class PathStaticFileHandler(StaticFileHandler):
    def initialize(self, search_path, default_filename=None):
        self.root = '/'
        self.search_path = search_path
        self.default_filename = default_filename

    def get(self, path=None, include_body=True):
        full_path = self.search_path.find_file(path, index_name=self.default_filename)
        if full_path is None:
            raise HTTPError(404)
        super(PathStaticFileHandler, self).get(full_path, include_body)
