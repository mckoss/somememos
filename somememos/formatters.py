import mimetypes
from markdown import markdown


class Formatter(object):
    def render(self, handler, content, extension, **kwargs):
        handler.render('page.html', content=content, **kwargs)
        return content


class HTML(Formatter):
    pass


class Markdown(Formatter):
    def render(self, handler, content, extension, **kwargs):
        content = markdown(content)
        handler.render('page.html', content=content, **kwargs)


class StaticFormatter(Formatter):
    def render(self, handler, content, extension, **kwargs):
        mime_type = mimetypes.guess_type('test.' + extension)[0]
        if mime_type is None:
            mime_type = 'application/octet-stream'
        handler.set_header("Content-Type", mime_type)
        handler.write(content)
