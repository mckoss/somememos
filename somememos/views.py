import os
import re
from datetime import datetime
import mimetypes
import logging

from tornado.web import RequestHandler, StaticFileHandler, HTTPError

from util import Struct, parse_path
from formatters import StaticFormatter


class PageRequestHandler(RequestHandler):
    def initialize(self, search_path=None, site_data=None, formatters=None, **kwargs):
        super(PageRequestHandler, self).initialize(**kwargs)
        self.search_path = search_path
        self.site_data = site_data
        self.formatters = formatters or {}
        self.static_formatter = StaticFormatter()

    def get(self, path):
        normal_path = self.search_path.normalize_path(path)
        if normal_path != path:
            self.redirect('/' + normal_path, permanent=True)
            return
        full_path = self.search_path.find_file(path)
        if full_path is None:
            raise HTTPError(404)
        (path, file_name, extension) = parse_path(full_path)

        with open(full_path, "rb") as content_file:
            content = content_file.read()

        formatter = self.formatters.get(extension, self.static_formatter)
        page_data = Struct(title=path)
        formatter.render(self, content, extension, site=self.site_data, page=page_data)
