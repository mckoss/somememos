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
import argparse
import logging

from tornado.options import define, options, parse_config_file, parse_command_line
from tornado import ioloop

from server import init_application, get_content_search_path
from util import parse_path


def main():
    commands = [func.rsplit('_', 1)[0] for func in globals() if func.endswith('_command')]
    commands.sort()
    user_commands = [command.replace('_', '-') for command in commands]
    usage = ["somememos  <" + ' | '.join(user_commands) + ">"]
    usage.append("Available commands:")
    usage.append('')
    for command in commands:
        usage.append("%s: %s" % (command.replace('_', '-'),
                                 globals()[command + '_command'].__doc__))

    parser = argparse.ArgumentParser(description="Somememos command script.",
                                     usage='\n'.join(usage))
    parser.add_argument('command', nargs='?', default='run-server', help="Command name.")
    parser.add_argument("extras", nargs='*')
    args = parser.parse_args()

    command_name = args.command.replace('-', '_')

    if command_name not in commands:
        print "Unknown command: %s" % args.command
        print parser.print_help()
        sys.exit(1)

    command_func = globals().get(command_name + '_command')
    command_func(*args.extras)


def run_server_command(*args):
    """
    Run web server for a given directory root location.

    $ run-server [directory]
    """
    start_server(get_root_dir(*args))


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


def start_server(root_dir):
    conf_file_name = os.path.join(root_dir, "somememos.conf")
    if os.path.exists(conf_file_name):
        parse_config_file(conf_file_name)
    parse_command_line()

    application = init_application(root_dir)
    logging.info("Starting SomeMemoS server on port %d.", options.host_port)
    application.listen(options.host_port)
    ioloop.IOLoop.instance().start()


if __name__ == '__main__':
    main()
