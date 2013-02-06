import os
import re
from datetime import datetime
import mimetypes

from tornado.web import RequestHandler, StaticFileHandler, HTTPError

from util import Struct, parse_path, slugify_path, normalize_path


class PageRequestHandler(RequestHandler):
    def initialize(self, search_path=None, site_data=None, formatters=None, **kwargs):
        super(PageRequestHandler, self).initialize(**kwargs)
        self.search_path = search_path
        self.site_data = site_data
        self.formatters = formatters

    def get(self, path):
        normal_path = normalize_path(path, hidden_extensions=self.formatters.keys(), sep='/')
        if normal_path != path:
            self.redirect('/' + normal_path, permanent=True)
            return
        full_path = self.search_path.find_file(path)
        if full_path is None:
            raise HTTPError(404)
        (path, filename, extension) = parse_path(full_path)

        with open(full_path, "rb") as content_file:
            content = content_file.read()

        if extension not in self.formatters.keys():
            mime_type = mimetypes.guess_type(full_path)[0]
            if mime_type:
                self.set_header("Content-Type", mime_type)
            self.finish(content)
            return

        content = self.formatters[extension].format(content)

        page_data = Struct(title=path)

        self.render('page.html', content=content, site=self.site_data, page=page_data)


class PathStaticFileHandler(StaticFileHandler):
    def initialize(self, search_path, default_filename='index.html'):
        self.root = '/'
        self.search_path = search_path
        self.default_filename = default_filename

    def get(self, path=None, include_body=True):
        full_path = self.search_path.find_file(path, index_name=self.default_filename)
        if full_path is None:
            raise HTTPError(404)
        super(PathStaticFileHandler, self).get(full_path, include_body)
