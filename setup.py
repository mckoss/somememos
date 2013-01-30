#!/usr/bin/env python

from setuptools import setup, find_packages

setup(name='webnotes',
      version='0.1',
      packages=find_packages(),
      install_requires=['tornado>=2.4'],
      )
