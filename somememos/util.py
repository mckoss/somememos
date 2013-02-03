import os
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

    def find_file(self, rel_path, index_name=None):
        if index_name is not None and rel_path == '' or rel_path[-1] == '/':
            rel_path += index_name
        for path in self.file_paths:
            full_path = os.path.join(path, rel_path)
            if os.path.exists(full_path):
                return full_path
        logging.info("Could not find file '%s' in path %r", rel_path, self.file_paths)

    def __add__(self, other):
        return SearchPath(*[os.path.join(path, other) for path in self.file_paths])
