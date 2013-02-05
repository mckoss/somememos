import os
import re
import glob
import logging


class Struct(dict):
    """
    A dict that allows for object-like property access syntax.
    """
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)

    def __setattr__(self, name, value):
        self[name] = value
        return value

    def keys(self):
        return [key for key in super(Struct, self).keys() if not key.startswith('_')]

    def clear(self):
        for key in self.keys():
            del self[key]


class SearchPath(object):
    def __init__(self, *file_paths):
        self.file_paths = [os.path.abspath(path) for path in file_paths]
        self.wildcard_extension = False

    def find_file(self, rel_path, index_name=None):
        if index_name is not None and rel_path == '' or rel_path[-1] == '/':
            rel_path += index_name

        for search_path in self.file_paths:
            full_path = os.path.join(search_path, rel_path)
            (path, filename, extension) = parse_path(full_path)

            if self.wildcard_extension and extension == '':
                for file_path in glob.iglob(full_path + '.*'):
                    # TODO: Should we force 301 redirect for directories withou terminal '/'?
                    if os.path.isdir(file_path):
                        return self.find_file(os.path.join(rel_path, index_name))
                    return file_path
                return None

            if not os.path.exists(full_path) or os.path.isdir(full_path):
                continue

            return full_path

        logging.info("Could not find file '%s' in path %r", rel_path, self.file_paths)

    def join(self, *more):
        return SearchPath(*[os.path.join(path, *more) for path in self.file_paths])


def parse_path(path):
    """
    Return (path, filename, extension).

    >>> parse_path(os.path.join('a', 'b'))
    ('a', 'b', '')
    >>> parse_path(os.path.join('a', 'b.c'))
    ('a', 'b', 'c')
    >>> parse_path(os.path.join('a.b', 'c'))
    ('a.b', 'c', '')
    >>> parse_path(os.path.join('a', 'b', 'c.d.e'))
    ('a/b', 'c.d', 'e')
    >>> parse_path('')
    ('', '', '')
    >>> parse_path(os.path.join('a', 'b', ''))
    ('a/b', '', '')
    >>> parse_path('.git')
    ('', '.git', '')
    """
    parts = path.rsplit(os.path.sep, 1)
    parent_path = parts[0] if len(parts) == 2 else ''
    filename_parts = parts[-1].rsplit('.', 1)
    filename = filename_parts[0]
    extension = filename_parts[1] if len(filename_parts) == 2 else ''
    if filename == '' and extension != '':
        filename = '.' + extension
        extension = ''
    return (parent_path, filename, extension)


def slugify_path(s):
    """
    Slugify each of the components of a path string.

    >>> slugify_path('.git/camelCase/a##b')
    '.git/camel-case/a-b'
    >>> slugify_path('simple')
    'simple'
    >>> slugify_path('simple test/another test')
    'simple-test/another-test'
    """
    parts = s.split(os.path.sep)
    parts = map(slugify, parts)
    return os.path.sep.join(parts)


reg_nonchar = re.compile(r"[^\w\.]")
reg_dashes = re.compile(r"[\-]+")
reg_dash_ends = re.compile(r"(^-+)|(-+$)")
reg_camel = re.compile(r"[a-z][A-Z]")


def slugify(s):
    """
    Convert runs of all non-alphanumeric characters to single dashes

    >>> slugify('hello')
    'hello'
    >>> slugify('hello there')
    'hello-there'
    >>> slugify('  1 a --c--- foo ')
    '1-a-c-foo'
    >>> slugify("A b's")
    'a-b-s'
    >>> slugify('camelCase')
    'camel-case'
    >>> slugify('file.txt')
    'file.txt'
    """
    def hyphenate(match):
        pair = match.group(0)
        pair = pair.lower()
        return pair[0] + '-' + pair[1]

    s = reg_camel.sub(hyphenate, s).lower()
    s = reg_nonchar.sub('-', s)
    s = reg_dashes.sub('-', s)
    s = reg_dash_ends.sub('', s)
    return s
