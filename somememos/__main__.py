#!/usr/bin/env python
"""
    Commads for SomeMemos web hosting system.

    A SomeMemoS web site consists of a collection of (source controlled) files
    that are rendered by the SomeMemos web server.  Like the Jekyll system,
    SomeMemos sites can be based on site-wide and document type tempaltes that
    control how individual pages are rendered.
"""
import os

from tornado.options import parse_config_file, parse_command_line

from server import start_server, get_content_search_path
from commands import CommandDispatch


def main():
    cmd = CommandDispatch(globals())
    conf_file_name = os.path.join(root_dir, "somememos.conf")
    if os.path.exists(conf_file_name):
        parse_config_file(conf_file_name)
    args = parse_command_line()

    if len(args) == 0:
        command_name = 'run_server'
    else:
        command_name = args[0].replace('-', '_')
        if command_name in commands:
            del args[0]
        else:
            command_name = 'run_server'

    command_func = globals().get(command_name + '_command')
    command_func(*args)


def run_server_command(*args):
    """
    Run web server for a given directory root location.

    $ run-server [directory]
    """
    root_dir = get_root_dir(*args)
    start_server(root_dir)


def check_files_command(*args):
    """
    Check all files and directory names for compliance with
    addressable naming conventions (all lower case).
    """
    module_dir = os.path.dirname(__file__)
    content_search_path = get_content_search_path(get_root_dir(*args), module_dir)
    for full_name in content_search_path.all_files():
        print full_name


def get_root_dir(*args):
    root_dir = args[0] if len(args) > 0 else os.getcwd()
    root_dir = os.path.abspath(root_dir)
    return root_dir


if __name__ == '__main__':
    main()
