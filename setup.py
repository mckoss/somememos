#!/usr/bin/env python

from setuptools import setup, find_packages

setup(name='somememos',
      version='0.1a3',
      packages=find_packages(),
      package_data={
        'somememos': ['content/js/*.js', 'content/css/*.css', 'img/*.png', 'img/*.ico',
                      'templates/*.html'],
        },
      install_requires=['tornado>=2.4',
                        'markdown>=2.2'],
      author="Mike Koss",
      author_email="mike@mckoss.com",
      description="A web application for publishing extensible notebooks.",
      license="MIT",
      keywords="tornado web",
      scripts=['bin/somememos'],
      )
