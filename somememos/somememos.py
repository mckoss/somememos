#!/usr/bin/env python
"""
    somememos.py - An extensible web framework.
"""
import os
import logging

from tornado.options import define, options, parse_config_file, parse_command_line
from tornado.web import RequestHandler, Application, StaticFileHandler, HTTPError
from tornado.template import Template, BaseLoader
from tornado import ioloop

from markdown import markdown

from util import Struct

define('host_port', default=8080, help="Web server port.")
define('theme', default='default', help="Theme name.")
define('site_title', default='SomeMemos', help="Your site name.")

site_data = None

FORMATTERS = {
    "md": Struct(format=markdown),
    }


def start_server(root_dir):
    conf_file_name = os.path.join(root_dir, "somememos.conf")
    if os.path.exists(conf_file_name):
        parse_config_file(conf_file_name)
    parse_command_line()

    application = init_application(root_dir)
    logging.info("Starting SomeMemoS server on port %d.", options.host_port)
    application.listen(options.host_port)
    ioloop.IOLoop.instance().start()


def init_application(root_dir):
    global site_data

    module_dir = os.path.dirname(__file__)

    template_search_path = SearchPath(os.path.join(root_dir, "themes", options.theme,
                                                   "templates"),
                                      os.path.join(root_dir, "templates"),
                                      os.path.join(module_dir, "themes", options.theme,
                                                   "templates"),
                                      os.path.join(module_dir, "templates"),
                                      )

    content_search_path = SearchPath(os.path.join(root_dir),
                                     os.path.join(module_dir, "content"))

    static_search_path = SearchPath(os.path.join(root_dir, "themes", options.theme,
                                                 "static"),
                                    os.path.join(root_dir, "static"),
                                    os.path.join(module_dir, "static"))

    settings = dict(
        gzip=True,
        template_loader=PathTemplateLoader(template_search_path),
        )

    application = Application([
        (r"/((?:img|js|css)/.*)$", PathStaticFileHandler, {"search_path": static_search_path}),
        (r"/(favicon\.ico)$", PathStaticFileHandler, {"search_path": static_search_path + 'img'}),
        (r"/(.*)$", PageRequestHandler, {"search_path": content_search_path}),
        ],
        **settings)

    site_data = Struct(title=options.site_title)

    return application


class PageRequestHandler(RequestHandler):
    def initialize(self, search_path=None, **kwargs):
        super(PageRequestHandler, self).initialize(**kwargs)
        self.search_path = search_path

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

        self.render('page.html', content=content, site=site_data, page=page_data)


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


class SearchPath(object):
    def __init__(self, *file_paths):
        self.file_paths = [os.path.abspath(path) for path in file_paths]

    def find_file(self, rel_path, index_name=None):
        if index_name is not None and rel_path == '' or rel_path[-1] == '/':
            rel_path += index_name
        for path in self.file_paths:
            full_path = os.path.join(path, rel_path)
            if os.path.exists(full_path):
                return full_path
        logging.info("Could not find file '%s' in path %r", rel_path, self.file_paths)

    def __add__(self, other):
        return SearchPath(*[os.path.join(path, other) for path in self.file_paths])


class PathTemplateLoader(BaseLoader):
    def __init__(self, search_path, **kwargs):
        self.search_path = search_path
        super(PathTemplateLoader, self).__init__(**kwargs)

    def resolve_path(self, name, parent_path=None):
        return name

    def _create_template(self, name):
        path = self.search_path.find_file(name)
        if path is None:
            return None
        with open(path, "rb") as template_file:
            template = Template(template_file.read(), name=name, loader=self)
        return template


if __name__ == '__main__':
    start_server(os.getcwd())
