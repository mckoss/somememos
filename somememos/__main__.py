#!/usr/bin/env python
"""
    Commads for SomeMemos web hosting system.

    A SomeMemoS web site consists of a collection of (source controlled) files
    that are rendered by the SomeMemos web server.  Like the Jekyll system,
    SomeMemos sites can be based on site-wide and document type tempaltes that
    control how individual pages are rendered.
"""
import os
import sys

from tornado.options import options, parse_config_file, parse_command_line
from tornado import options as options_module

from server import start_server, get_content_search_path
from cmdfuncs import CommandDispatch


cmd = None


def main():
    global cmd

    cmd = CommandDispatch(globals())
    args = parse_command_line()
    if not cmd.dispatch(args, default='run-server'):
        print "Unknown command: %s" % args[0]
        print_help()


def print_help(output=sys.stdout):
    """Prints all the command line options to stdout - replacment for tornano's print_help. """
    options.print_help(output)
    if cmd is not None:
        print >> output, cmd.get_usage()


options_module.print_help = print_help


def help_command(*args):
    """ Print this help message. """
    print_help()


def run_server_command(*args):
    """
    Run web server for a given directory root location.

        run-server [directory]

    This is default command if none given.
    """
    root_dir = get_root_dir(*args)
    conf_file_name = os.path.join(root_dir, "somememos.conf")
    if os.path.exists(conf_file_name):
        parse_config_file(conf_file_name)

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
