"""
    commands.py - Utility for dispatching command within a module or file.

    Usage:

    # Read command functions from (current) module
    cmd = CommandDispatch(globals())
    print cmd.get_usage()
    cmd.get_func('sample')()

    # Read command functions from module
    cmd = CommandDispatch(module)

    # Read command functions from class
    cmd = CommandDispatch(self)
"""
import re
from types import FunctionType


class CommandDispatch(object):
    def __init__(self, command_dict):
        if hasattr(command_dict, '__dict__'):
            command_dict = command_dict.__dict__
        command_names = [name.rsplit('_', 1)[0] for name in command_dict.keys()
                          if name.endswith('_command') and
                          isinstance(command_dict[name], FunctionType)]
        self.commands = dict([(name, command_dict[name + '_command']) for name in command_names])
        if 'help' not in self.commands:
            self.commands['help'] = self.help_command

    def dispatch(self, args, default=None):
        """
        Dispatch command line where first argument is command name.

        Returns True if succsessful.
        """
        args = list(args)
        if len(args) == 0:
            command_name = default
        else:
            command_name = args[0]
            if self.get_func(command_name) is not None:
                del args[0]
            else:
                command_name = default

        command_func = self.get_func(command_name)
        if command_func is not None:
            command_func(*args)
            return True
        return False

    def get_func(self, command_name):
        command_name = command_name.replace('-', '_')
        if command_name in self.commands:
            return self.commands[command_name]

    def help_command(self, *args):
        """ Print list of commands. """
        print self.get_usage()

    def get_usage(self):
        usage = ["Commands:"]
        usage.extend(["  {:28s} ".format(name.replace('_', '-')) +
                      indent_text(self.get_func(name).__doc__, 31, hanging=True)
                      for name in self.commands])
        return '\n\n'.join(usage)


def indent_text(s, spaces=4, hanging=False):
    """
    Indent text so that each line begins with spaces.  If hanging is true,
    the first line is not indented.

    >>> print indent_text('foo\\n bar', 2)
      foo
       bar
    >>> print indent_text('foo\\n bar', 2, hanging=2)
    foo
       bar
    """
    s = remove_indent(s)
    prefix = ' ' * spaces
    return '\n'.join([(prefix if i > 0 or not hanging else '') + line
                      for (i, line) in enumerate(s.split('\n'))])


reg_spaces = re.compile(r" *")
reg_blank = re.compile(r"\s*$")


def remove_indent(s):
    """
    Remove the indentation from all the lines of the given string (using the first line
    as a guide.).

    >>> remove_indent('a')
    'a'
    >>> remove_indent('   a ')
    'a '
    >>> print remove_indent(' a\\n  b\\n c')
    a
     b
    c
    >>> print remove_indent('  a\\n b')
    a
    b
    >>> print remove_indent('\\n    a\\n    b')
    a
    b
    >>> remove_indent(None)
    ''
    >>> remove_indent(1)
    '1'
    """
    if s is None:
        return ''
    s = str(s)
    lines = s.split('\n')
    if len(lines) == 0:
        return ''

    while reg_blank.match(lines[0]):
        del lines[0]
        if len(lines) == 0:
            return ''

    while reg_blank.match(lines[-1]):
        del lines[-1]
        if len(lines) == 0:
            return ''

    first_indent = len(reg_spaces.match(lines[0]).group(0))
    for i in range(len(lines)):
        indent = len(reg_spaces.match(lines[i]).group(0))
        lines[i] = lines[i][min(indent, first_indent):]

    return '\n'.join(lines)
