#!/usr/bin/env python

from setuptools import setup, find_packages

setup(name='webnotes',
      version='0.1a1',
      packages=find_packages(),
      install_requires=['tornado>=2.4'],
      author="Mike Koss",
      author_email="mike@mckoss.com",
      description="A web application for publishing extensible notebooks.",
      license="MIT",
      keywords="tornado web",
      uri="http://github.com/mckoss/webnotes",
      scripts=['bin/webnotes'],
      )
