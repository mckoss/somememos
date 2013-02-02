#!/usr/bin/env python
"""
    somememos.py - An extensible web framework.
"""
import os
import logging

from tornado.options import define, options, parse_config_file, parse_command_line
from tornado.web import RequestHandler, Application, StaticFileHandler
from tornado import httpserver
from tornado import ioloop

define('host_port', default=8080, help='Web server port.')


class PageRequestHandler(RequestHandler):
    def get(self, path):
        self.write("Hello, world: '%s'" % path)


def start_server(root_dir):
    module_dir = os.path.dirname(__file__)
    conf_file_name = os.path.join(root_dir, "somememos.conf")
    if os.path.exists(conf_file_name):
        parse_config_file(conf_file_name)
    parse_command_line()

    settings = dict(
        gzip=True,
        template_path=os.path.join(root_dir, os.path.join(module_dir, 'templates')),
        )

    application = Application([
        (r"/images/(.*)", StaticFileHandler, {"path": os.path.join(root_dir, "static/images")}),
        (r"/js/(.*)", StaticFileHandler, {"path": os.path.join(root_dir, "static/js")}),
        (r"/css/(.*)", StaticFileHandler, {"path": os.path.join(root_dir, "static/css")}),
        (r"/(.*)", PageRequestHandler),
        ],
        **settings)

    logging.info("Starting SomeMemoS server on port %d.", options.host_port)
    application.listen(options.host_port)
    ioloop.IOLoop.instance().start()


if __name__ == '__main__':
    start_server(os.getcwd())
