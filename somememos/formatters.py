from markdown import markdown


class Formatter(object):
    def format(self, content, file_name=None):
        return content


class Markdown(Formatter):
    def format(self, content):
        return markdown(content)


class HTML(Formatter):
    pass
