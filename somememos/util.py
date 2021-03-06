import os
import re
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
    def __init__(self, search_roots, index_names=None, hidden_extensions=None,
                 protected_files=None):
        self.search_roots = [os.path.abspath(path) for path in search_roots]
        self.index_names = index_names
        self.hidden_extensions = hidden_extensions or []
        self.protected_files = protected_files

    def find_file(self, rel_path):
        """
        Search for file using path - uses '/' not OS-specific delimeter.
        """
        if self.protected_files and self.protected_files.match(rel_path):
            return None

        if self.index_names is not None and (rel_path == '' or rel_path[-1] == '/'):
            for index_name in self.index_names:
                full_path = self.find_file(rel_path + '/' + index_name)
                if full_path is not None:
                    return full_path
            return None

        rel_path = self.normalize_path(rel_path.replace('/', os.path.sep))

        for search_path in self.search_roots:
            full_path = os.path.join(search_path, rel_path)

            extended_path = self.extended_file_exists(full_path)
            if extended_path is not None:
                return extended_path

            if os.path.isdir(full_path):
                if self.index_names is None:
                    return full_path
                for index_name in self.index_names:
                    full_path = self.extended_file_exists(os.path.join(full_path, index_name))
                    if full_path is not None:
                        return full_path

        logging.info("Could not find file '%s' in path %r", rel_path, self.search_roots)

    def extended_file_exists(self, path):
        if os.path.isfile(path):
            return path
        for extension in self.hidden_extensions:
            extended_path = path + '.' + extension
            if os.path.isfile(extended_path):
                return extended_path

    def all_files(self):
        """
        Iterate over all unprotected files in search path.

        Returns tuple (rel_path, abs_path)

        Files found in earlier roots can "shadow" files that occur later (duplicate relative
        paths will not be returned).
        """
        duplicates = set()
        for root_dir in self.search_roots:
            for (dirpath, dir_names, file_names) in os.walk(root_dir):
                for d in dir_names:
                    if self.protected_files and self.protected_files.match(d):
                        dir_names.remove(d)
                for file_name in file_names:
                    if self.protected_files and self.protected_files.match(file_name):
                        continue
                    full_path = os.path.join(dirpath, file_name)
                    normal_path = self.normalize_path(full_path[len(root_dir) + 1:])
                    normal_path.replace(os.path.sep, '/')
                    if normal_path not in duplicates:
                        duplicates.add(normal_path)
                        yield (normal_path, full_path)

    def normalize_path(self, path, sep=None):
        return path

    def join(self, *more):
        return SearchPath([os.path.join(path, *more) for path in self.search_roots],
                          index_names=self.index_names,
                          hidden_extensions=self.hidden_extensions,
                          protected_files=self.protected_files)


class NormalizedSearchPath(SearchPath):
    """
    Search path that enforces normalized file and directory names.

    Ensure all lower case, remove file extension, convert camel case to hyphenated.  If the
    index name is explicitly included, remove it.
    """
    def prescan_files(self):
        self.path_map = {}
        for (path, full_path) in self.all_files():
            self.path_map[path] = full_path
            if path.endswith('/'):
                self.path_map[path[:-1]] = os.path.dirname(full_path)

    def find_file(self, rel_path):
        if not hasattr(self, 'path_map'):
            self.prescan_files()

        normal_path = self.normalize_path(rel_path, sep='/')
        return self.path_map.get(normal_path)

    def normalize_path(self, path, sep=None):
        """
        Ensure all lower case, remove file extension, convert camel case to hyphenated.  If the
        index name is explicitly included, remove it.

        >>> S = NormalizedSearchPath(['/root'], hidden_extensions=['md'], index_names=('index',))
        >>> S.normalize_path('ABC')
        'abc'
        >>> S.normalize_path('camelCase')
        'camel-case'
        >>> S.normalize_path('a/b/test.txt', sep='/')
        'a/b/test.txt'
        >>> S.normalize_path('a/b/test.md', sep='/')
        'a/b/test'
        >>> S.normalize_path('a/index', sep='/')
        'a/'
        >>> S.normalize_path('index')
        ''
        """
        if sep is None:
            sep = os.path.sep
        path = slugify_path(path, sep=sep)
        if len(path) == 0:
            return path

        (path, file_name, extension) = parse_path(path, sep=sep)
        result = sep.join([path, file_name]) if len(path) > 0 else file_name
        if extension != '' and (extension not in self.hidden_extensions):
            result += '.' + extension
        if self.index_names is None:
            return result
        for index_name in self.index_names:
            if result.endswith(sep + index_name) or result == index_name:
                result = result[:-len(index_name)]
                break
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


reg_nonchar = re.compile(r"[^a-zA-Z0-9\.]")
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
    >>> slugify('hello_there')
    'hello-there'
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
