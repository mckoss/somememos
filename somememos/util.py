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
