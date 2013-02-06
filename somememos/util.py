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
    """
    Search file directories looking for matching path.  Allows for implied file extensions
    and regular expression for prohibited files.  Directory matches return the corresponding
    index file if given.
    """
    def __init__(self, file_paths, index_name=None, hidden_extensions=None, protected_files=None):
        self.file_paths = [os.path.abspath(path) for path in file_paths]
        self.index_name = index_name
        self.hidden_extensions = hidden_extensions or []
        self.protected_files = protected_files

    def find_file(self, rel_path):
        if self.protected_files and self.protected_files.match(rel_path):
            return None

        rel_path = rel_path.replace('/', os.path.sep)

        if self.index_name is not None and (rel_path == '' or rel_path[-1] == '/'):
            rel_path += self.index_name

        for search_path in self.file_paths:
            full_path = os.path.join(search_path, rel_path)

            extended_path = self.extended_file_exists(full_path)
            if extended_path is not None:
                return extended_path

            if os.path.isdir(full_path):
                if self.index_name is None:
                    return full_path
                full_path = self.extended_file_exists(os.path.join(full_path, self.index_name))
                if full_path is not None:
                    return full_path

        logging.info("Could not find file '%s' in path %r", rel_path, self.file_paths)

    def extended_file_exists(self, path):
        if os.path.isfile(path):
            return path
        for extension in self.hidden_extensions:
            extended_path = path + '.' + extension
            if os.path.isfile(extended_path):
                return extended_path

    def join(self, *more):
        return SearchPath(*[os.path.join(path, *more) for path in self.file_paths])


def normalize_path(path, hidden_extensions=None, index_name='index', sep=None):
    """
    Ensure all lower case, remove file extension, convert camel case to hyphenated.  If the
    index name is explicitly included, remove it.

    >>> normalize_path('ABC')
    'abc'
    >>> normalize_path('camelCase')
    'camel-case'
    >>> normalize_path('a/b/test.txt')
    'a/b/test.txt'
    >>> normalize_path('a/b/test.md', ['md'])
    'a/b/test'
    >>> normalize_path('a/index')
    'a/'
    >>> normalize_path('index')
    ''
    """
    if sep is None:
        sp = os.path.sep
    path = slugify_path(path, sep=sep)
    if len(path) == 0:
        return path

    (path, file_name, extension) = parse_path(path, sep='/')
    result = '/'.join([path, file_name]) if len(path) > 0 else file_name
    if extension != '' and (hidden_extensions is None or extension not in hidden_extensions):
        result += '.' + extension
    if result.endswith('/' + index_name) or result == index_name:
        result = result[:-len(index_name)]
    return result


def parse_path(path, sep=None):
    """
    Return (path, filename, extension).

    >>> parse_path('a/b', '/')
    ('a', 'b', '')
    >>> parse_path('a/b.c', '/')
    ('a', 'b', 'c')
    >>> parse_path('a.b/c', '/')
    ('a.b', 'c', '')
    >>> parse_path('a/b/c.d.e', '/')
    ('a/b', 'c.d', 'e')
    >>> parse_path('')
    ('', '', '')
    >>> parse_path('a/b/', '/')
    ('a/b', '', '')
    >>> parse_path('.git', '/')
    ('', '.git', '')
    """
    if sep is None:
        sep = os.path.sep
    parts = path.rsplit(sep, 1)
    parent_path = parts[0] if len(parts) == 2 else ''
    filename_parts = parts[-1].rsplit('.', 1)
    filename = filename_parts[0]
    extension = filename_parts[1] if len(filename_parts) == 2 else ''
    if filename == '' and extension != '':
        filename = '.' + extension
        extension = ''
    return (parent_path, filename, extension)


def slugify_path(s, sep=None):
    """
    Slugify each of the components of a path string.

    >>> slugify_path('.git/camelCase/a##b', '/')
    '.git/camel-case/a-b'
    >>> slugify_path('simple')
    'simple'
    >>> slugify_path('simple test/another test', '/')
    'simple-test/another-test'
    """
    if sep is None:
        sep = os.path.sep
    parts = s.split(sep)
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
