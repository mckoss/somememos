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
    def __init__(self, module):
        self.module = module
        self.command_names = [name.rsplit('_', 1)[0] for name in dir(modules)
                              if name.endswith('_command') and
                                  type(getattr(module, name)) == FunctionType]
        self.command_names.sort()

    def get_func(self, command_name):
        command_name = user_name.replace('-', '_')
        if command_name in self.command_names:
            return getattr(self.module, command_name + '_command')

    def get_usage(self):
        usage = '\n'.join(["  {:10s}  ".format(name.replace('_', '-')) +
                           indent_text(self.get_func(name), 14, hanging=True)
                           for name in self.command_names])
        return usage


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
    """
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

    first_indent = len(reg_spaces.match(s).group(0))
    for i in range(len(lines)):
        indent = len(reg_spaces.match(lines[i]).group(0))
        lines[i] = lines[i][min(indent, first_indent):]

    return '\n'.join(lines)
