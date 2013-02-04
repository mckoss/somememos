#!/usr/bin/env python
import os
import unittest
import doctest

from somememos import views


def load_tests(loader, tests, ignore):
    tests.addTests(doctest.DocTestSuite(views))
    return tests


if __name__ == '__main__':
    unittest.main()
