"""Read one bounded RSS document on stdin; emit public sayings only, never raw HTML."""
import datetime as dt
import email.utils
import hashlib
import html.parser
import json
import sys
import urllib.parse
import xml.etree.ElementTree as ET


def safe_url(value, base):
    if not value:
        return None
    url = urllib.parse.urljoin(base, value or '')
    parsed = urllib.parse.urlparse(url)
    return url if parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password else None


class Content(html.parser.HTMLParser):
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.parts, self.images, self.media, self.links, self.skip = base, [], [], [], [], 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('script', 'style'):
            self.skip += 1
        if self.skip:
            return
        if tag in ('p', 'div', 'blockquote', 'li', 'br', 'h1', 'h2', 'h3', 'h4'):
            self.parts.append('\n')
        if tag == 'img':
            url = safe_url(a.get('data-src') or a.get('src'), self.base)
            if url:
                self.images.append({'url': url, 'alt': a.get('alt', '')})
        if tag == 'a':
            url = safe_url(a.get('href'), self.base) if a.get('href') else None
            if url:
                self.links.append(url)
        if tag in ('iframe', 'audio', 'video', 'source') and a.get('src'):
            url = safe_url(a['src'], self.base)
            if url:
                self.media.append({'url': url, 'kind': tag, 'title': a.get('title', '')})

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)
        if tag in ('p', 'div', 'blockquote', 'li') and not self.skip:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def parse(raw):
    if len(raw) > 2000000 or b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('Invalid RSS document')
    root = ET.fromstring(raw)
    channel = root.find('channel')
    if root.tag != 'rss' or channel is None:
        raise ValueError('Invalid RSS document')
    items = channel.findall('item')
    entries = []
    for item in items:
        link = item.findtext('link') or ''
        parsed = urllib.parse.urlparse(link)
        if parsed.scheme != 'https' or parsed.hostname != 'www.ashsilent.com' or parsed.username or parsed.password:
            raise ValueError('Unexpected RSS source')
        path = parsed.path.strip('/').split('/')
        if len(path) != 2 or path[0] != 'shuoshuo':
            continue
        guid = item.findtext('guid') or link
        numeric = urllib.parse.parse_qs(urllib.parse.urlparse(guid).query).get('p', [''])[0]
        if not numeric.isdigit():
            numeric = path[1] if path[1].isdigit() else ''
        identifier = numeric or 'guid-' + hashlib.sha256(guid.encode()).hexdigest()[:24]
        date = email.utils.parsedate_to_datetime(item.findtext('pubDate') or '')
        if date.tzinfo is None:
            date = date.replace(tzinfo=dt.timezone.utc)
        content = Content(link)
        content.feed(item.findtext('{http://purl.org/rss/1.0/modules/content/}encoded') or item.findtext('description') or '')
        content.close()
        entries.append({'id': 'ashsilent:shuoshuo:' + identifier, 'sourceUrl': link,
            'date': date.astimezone(dt.timezone.utc).isoformat(),
            'text': '\n'.join(line.strip() for line in ''.join(content.parts).splitlines() if line.strip()),
            'title': item.findtext('title') or '', 'author': item.findtext('{http://purl.org/dc/elements/1.1/}creator') or '',
            'images': content.images, 'media': content.media, 'links': list(dict.fromkeys(content.links))})
    return {'itemCount': len(items), 'entries': entries}


if __name__ == '__main__':
    try:
        print(json.dumps(parse(sys.stdin.buffer.read(2000001)), ensure_ascii=False))
    except Exception:
        print('RSS parsing failed', file=sys.stderr)
        sys.exit(1)
