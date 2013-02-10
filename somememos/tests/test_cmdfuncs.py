#!/usr/bin/env python
import unittest
import doctest

from somememos import cmdfuncs


def load_tests(loader, tests, ignore):
    tests.addTests(doctest.DocTestSuite(cmdfuncs))
    return tests


if __name__ == '__main__':
    unittest.main()
