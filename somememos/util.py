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
        self.match_any_extension = False

    def find_file(self, rel_path, index_name=None):
        if index_name is not None and rel_path == '' or rel_path[-1] == '/':
            rel_path += index_name

        for search_path in self.file_paths:
            full_path = os.path.join(search_path, rel_path)

            if self.match_any_extension:
                for file_path in glob.iglob(full_path + '*'):
                    if os.path.isdir(file_path):
                        continue
                    return file_path
                return None

            if not os.path.exists(full_path) or os.path.isdir(full_path):
                continue

            return full_path
        logging.info("Could not find file '%s' in path %r", rel_path, self.file_paths)

    def __add__(self, other):
        return SearchPath(*[os.path.join(path, other) for path in self.file_paths])


reg_camel = re.compile(r"[a-z][A-Z]")


def normalize_path(path):
    """ Ensure all lower case, remove file extension, convert camel case to hyphenated. """
    def hyphenate(match):
        pair = match.group(0)
        pair = pair.lower()
        return pair[0] + '-' + pair[1]

    path = reg_camel.sub(hyphenate, path).lower()
    if len(path) == 0 or path[-1] == '/':
        return path

    parts = path.rsplit('/', 1)
    parts[-1] = parts[-1].rsplit('.', 1)[0]
    return ''.join(parts)
