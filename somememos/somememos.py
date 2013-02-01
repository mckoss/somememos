#!/usr/bin/env python
"""
    somememos.py - An extensible web framework.
"""
import os
import logging

from tornado.options import define, options, parse_config_file, parse_command_line
from tornado import httpserver
from tornado import ioloop

define('host_port', default=8080, help='Web server port.')


class RequestHandler(object):
    def __call__(self, request):
        message = "You requested %s\n" % request.uri
        request.write("HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s" %
                      (len(message), message))
        request.finish()


def start_server(root_dir):
    conf_file_name = os.path.join(root_dir, "somememos.conf")
    if os.path.exists(conf_file_name):
        parse_config_file(conf_file_name)
    parse_command_line()

    handler = RequestHandler()
    server = httpserver.HTTPServer(handler)
    server.listen(options.host_port)
    logging.info("Starting SomeMemoS server on port %d.", options.host_port)
    ioloop.IOLoop.instance().start()


if __name__ == '__main__':
    start_server(os.getcwd())
