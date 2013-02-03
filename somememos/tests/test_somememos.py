#!/usr/bin/env python
import os
import unittest
from tornado.testing import AsyncHTTPTestCase

import somememos


class SomeMemosTest(AsyncHTTPTestCase):
    def get_app(self):
        test_dir = os.path.dirname(__file__)
        return somememos.init_application(os.path.join(test_dir, 'sample'))

    def test_index(self):
        response = self.fetch('/')
        self.assertEqual(response.code, 200)

    def test_markdown(self):
        response = self.fetch('/page.md')
        self.assertEqual(response.code, 200)


if __name__ == '__main__':
    unittest.main()
