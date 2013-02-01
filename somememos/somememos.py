"""
    somememos.py - An extensible web framework.
"""
from tornado import define, options
from tornado import httpserver
from tornado import ioloop

define('host_port', default=8080, 'Web server port.')


class RequestHandler(object):
    def __call__(self, request):
        message = "You requested %s\n" % request.uri
        request.write("HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s" %
                      (len(message), message))
        request.finish()


def start_server():
    handler = RequestHandler()
    server = httpserver.HTTPServer(handler)
    server.listen(options.port)
    ioloop.IOLoop.instance().start()
