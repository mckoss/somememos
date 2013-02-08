#!/usr/bin/env python
import unittest
import doctest

from somememos import util


def load_tests(loader, tests, ignore):
    tests.addTests(doctest.DocTestSuite(util))
    return tests


if __name__ == '__main__':
    unittest.main()
