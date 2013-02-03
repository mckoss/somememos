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

define('host_port', default=8080, help='Web server port.')
define('theme', default='default', help='Theme name.')

global_template_data = dict()


def start_server(root_dir):
    if os.path.exists(conf_file_name):
        parse_config_file(conf_file_name)
    parse_command_line()

    application = init_application(root_dir)
    logging.info("Starting SomeMemoS server on port %d.", options.host_port)
    application.listen(options.host_port)
    ioloop.IOLoop.instance().start()


def init_application(root_dir):
    module_dir = os.path.dirname(__file__)
    conf_file_name = os.path.join(root_dir, "somememos.conf")
    template_search_path = SearchPath(os.path.join(root_dir, "themes", options.theme,
                                                   "templates"),
                                      os.path.join(root_dir, "templates"),
                                      os.path.join(module_dir, "themes", options.theme,
                                                   "templates"),
                                      os.path.join(module_dir, "templates"),
                                      )

    file_path = SearchPath(os.path.join(root_dir),
                           os.path.join(module_dir, "static"))

    settings = dict(
        gzip=True,
        template_loader=PathTemplateLoader(template_search_path),
        )

    application = Application([
        (r"/images/(.*)", StaticFileHandler, {"path": os.path.join(root_dir, "static/images")}),
        (r"/js/(.*)", StaticFileHandler, {"path": os.path.join(root_dir, "static/js")}),
        (r"/css/(.*)", StaticFileHandler, {"path": os.path.join(root_dir, "static/css")}),
        (r"/(.*)", PageRequestHandler, {"path": file_path}),
        ],
        **settings)

    return application


class PageRequestHandler(RequestHandler):
    def initialize(self, path=None, **kwargs):
        super(PageRequestHandler, self).initialize(**kwargs)
        self.path = path

    def get(self, path):
        full_path = self.path.find_file(path, 'index.html')
        if full_path is None:
            raise HTTPError(404)
        with open(full_path, "rb") as content_file:
            content = content_file.read()
        self.render('page.html', content=content, **global_template_data)


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
