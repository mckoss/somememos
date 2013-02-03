import os

from markdown import markdown
from tornado.web import RequestHandler, StaticFileHandler, HTTPError

from util import Struct

FORMATTERS = {
    "md": Struct(format=markdown),
    }


class PageRequestHandler(RequestHandler):
    def initialize(self, search_path=None, site_data=None, **kwargs):
        super(PageRequestHandler, self).initialize(**kwargs)
        self.search_path = search_path
        self.site_data = site_data

    def get(self, path):
        full_path = self.search_path.find_file(path, 'index.html')
        if full_path is None:
            raise HTTPError(404)
        with open(full_path, "rb") as content_file:
            content = content_file.read()

        basename = os.path.basename(full_path)
        if '.' in basename:
            (name, extension) = basename.split('.')
            if extension in FORMATTERS:
                content = FORMATTERS[extension].format(content)

        page_data = Struct(title=path)

        self.render('page.html', content=content, site=self.site_data, page=page_data)


class PathStaticFileHandler(StaticFileHandler):
    def initialize(self, search_path, default_filename=None):
        self.root = '/'
        self.search_path = search_path
        self.default_filename = default_filename

    def get(self, path=None, include_body=True):
        full_path = self.search_path.find_file(path, index_name=self.default_filename)
        if full_path is None:
            raise HTTPError(404)
        return super(PathStaticFileHandler, self).get(full_path, include_body)
