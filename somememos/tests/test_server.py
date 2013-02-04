#!/usr/bin/env python
import os
import unittest
from tornado.testing import AsyncHTTPTestCase
from tornado.httpclient import HTTPRequest

from somememos import server


class SomeMemosTest(AsyncHTTPTestCase):
    def get_app(self):
        test_dir = os.path.dirname(__file__)
        return server.init_application(os.path.join(test_dir, 'sample'))

    def test_index(self):
        response = self.fetch('/')
        self.assertEqual(response.code, 200)

    def test_static(self):
        response = self.fetch('/js/jquery.js')
        self.assertEqual(response.code, 200)
        response = self.fetch('/css/bootstrap.css')
        self.assertEqual(response.code, 200)

    def test_redir(self):
        tests = [('/index', '/'),
                 ('/index.html', '/'),
                 ('/index.md', '/'),
                 ]
        for test in tests:
            self.http_client.fetch(HTTPRequest(self.get_url(test[0]), follow_redirects=False),
                                   self.stop)
            response = self.wait()
            self.assertEqual(response.code, 301)
            self.assertEqual(response.headers['Location'], test[1],
                             "%s -> %s (expected %s)" % (test[0], response.headers['Location'],
                                                         test[1]))

    def test_markdown(self):
        self.http_client.fetch(HTTPRequest(self.get_url('/page.md'), follow_redirects=False),
                               self.stop)
        response = self.wait()
        self.assertEqual(response.code, 301)
        self.http_client.fetch(HTTPRequest(self.get_url('/page.md'), follow_redirects=True),
                               self.stop)
        response = self.wait()
        self.assertEqual(response.code, 200)
        self.assertIn("<h1>Sample", response.body)

        response = self.fetch('/page')
        self.assertEqual(response.code, 200)


if __name__ == '__main__':
    unittest.main()
