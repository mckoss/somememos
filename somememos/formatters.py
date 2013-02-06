"""
    formatters.py - File rendering classes.
"""
import re
import mimetypes

from markdown import markdown


class Formatter(object):
    def render(self, handler, content, extension, **kwargs):
        handler.render('page.html', content=content, **kwargs)
        return content


reg_html = re.compile(r"\s*<html", re.IGNORECASE)


class HTML(Formatter):
    def render(self, handler, content, extension, **kwargs):
        if reg_html.match(content):
            handler.write(content)
            return
        super(HTML, self).render(handler, content, extension, **kwargs)


class Markdown(Formatter):
    def render(self, handler, content, extension, **kwargs):
        content = markdown(content)
        super(Markdown, self).render(handler, content, extension, **kwargs)


class StaticFormatter(Formatter):
    def render(self, handler, content, extension, **kwargs):
        mime_type = mimetypes.guess_type('test.' + extension)[0]
        if mime_type is None:
            mime_type = 'application/octet-stream'
        handler.set_header("Content-Type", mime_type)
        handler.write(content)
