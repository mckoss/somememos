#!/usr/bin/env python
import os
import unittest

from somememos import util


class NormalizeTest(unittest.TestCase):
    def test_lower(self):
        self.assertEqual(util.normalize_path('ABC'), 'abc')

    def test_camel(self):
        self.assertEqual(util.normalize_path('camelCase'), 'camel-case')


if __name__ == '__main__':
    unittest.main()
