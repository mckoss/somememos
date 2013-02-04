"""
    Commads for SomeMemos web hosting system.

    A SomeMemoS web site consists of a collection of (source controlled) files
    that are rendered by the SomeMemos web server.  Like the Jekyll system,
    SomeMemos sites can be based on site-wide and document type tempaltes that
    control how individual pages are rendered.
"""
import os
import sys
import argparse
import somememos
import logging

from tornado.options import define, options
from tornado.web import Application, HTTPError
from tornado.template import Template, BaseLoader

from util import Struct, SearchPath

from views import PageRequestHandler

define('host_port', default=8080, help="Web server port.")
define('theme', default='default', help="Theme name.")
define('site_title', default='SomeMemos', help="Your site name.")

site_data = None


def init_application(root_dir):
    global site_data

    module_dir = os.path.dirname(__file__)

    template_search_path = SearchPath(*(theme_paths(root_dir, 'templates') +
                                        theme_paths(module_dir, 'templates')))

    content_search_path = SearchPath(os.path.join(root_dir),
                                     *theme_paths(module_dir, 'content'))
    content_search_path.wildcard_extension = True

    settings = dict(
        gzip=True,
        template_loader=PathTemplateLoader(template_search_path),
        )

    site_data = Struct(title=options.site_title)

    application = Application([
        (r"/(favicon\.ico)$", PageRequestHandler, {"search_path": content_search_path.join('img')}),
        (r"/(.*)$", PageRequestHandler, {"search_path": content_search_path,
                                         "site_data": site_data}),
        ],
        **settings)

    return application


def theme_paths(root_dir, dir_name):
    return [os.path.join(root_dir, 'themes', options.theme, dir_name),
            os.path.join(root_dir, dir_name)]


class PathTemplateLoader(BaseLoader):
    def __init__(self, search_path, **kwargs):
        self.search_path = search_path
        super(PathTemplateLoader, self).__init__(**kwargs)

    def resolve_path(self, name, parent_path=None):
        return name

    def _create_template(self, name):
        path = self.search_path.find_file(name)
        if path is None:
            return None
        with open(path, "rb") as template_file:
            template = Template(template_file.read(), name=name, loader=self)
        return template
