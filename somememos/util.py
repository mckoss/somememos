import os
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
                    if os.path.isdir(file_path):
                        continue
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
    """
    parts = path.rsplit(os.path.sep, 1)
    parent_path = parts[0] if len(parts) == 2 else ''
    filename_parts = parts[-1].rsplit('.', 1)
    filename = filename_parts[0]
    extension = filename_parts[1] if len(filename_parts) == 2 else ''
    return (parent_path, filename, extension)
