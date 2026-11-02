"""
Reading news feeds (RSS and Atom)
=================================
An RSS feed is an XML file a news site keeps updated with its latest stories.
Each story is an <item> with a <title>, <link>, <description> (a short summary),
<pubDate> and a <guid> (a unique id). Atom feeds are the same idea with
different tag names (<entry>, <summary>, <updated>, <id>).

This file only uses Python's standard library, so there is nothing extra to install.
"""

import datetime as dt
import email.utils
import html
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

USER_AGENT = "CampusSentinel/1.0 (ASU BMI 461 class project; syndromic surveillance)"
ATOM = "{http://www.w3.org/2005/Atom}"
CONTENT = "{http://purl.org/rss/1.0/modules/content/}"


def strip_html(text):
    """Article summaries often contain HTML tags: drop them and decode &amp; etc."""
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text or "", flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def parse_date(value):
    """RSS dates look like 'Mon, 02 Nov 2026 14:05:00 GMT'; Atom dates like '2026-11-02T14:05:00Z'."""
    value = (value or "").strip()
    if not value:
        return None
    try:
        d = email.utils.parsedate_to_datetime(value)          # RSS style
    except (TypeError, ValueError):
        try:
            d = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))   # Atom style
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc)


def fetch(source, cache=None):
    """The feed's XML as text. `source` is a web address or a file on this computer.

    For web feeds, `cache` remembers the ETag / Last-Modified headers, so the next
    request asks "anything new since last time?" and an unchanged feed costs almost nothing.
    Returns None when the feed hasn't changed.
    """
    if not re.match(r"https?://", source):
        with open(source, encoding="utf-8") as f:
            return f.read()
    headers = {"User-Agent": USER_AGENT}
    if cache is not None and source in cache:
        headers.update(cache[source])
    try:
        with urllib.request.urlopen(urllib.request.Request(source, headers=headers), timeout=20) as r:
            if cache is not None:
                cache[source] = {k: v for k, v in (("If-None-Match", r.headers.get("ETag")),
                                                  ("If-Modified-Since", r.headers.get("Last-Modified"))) if v}
            return r.read().decode(r.headers.get_content_charset() or "utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 304:                                     # 304 Not Modified: nothing new
            return None
        raise


def parse(xml_text):
    """(outlet name, list of stories). Each story: id, title, link, summary, content, published."""
    root = ET.fromstring(xml_text)
    stories = []
    if root.tag == ATOM + "feed":                             # Atom
        outlet = (root.findtext(ATOM + "title") or "").strip()
        for e in root.findall(ATOM + "entry"):
            link = next((l.get("href") for l in e.findall(ATOM + "link") if l.get("rel", "alternate") == "alternate"), "")
            stories.append({
                "id": (e.findtext(ATOM + "id") or link or e.findtext(ATOM + "title") or "").strip(),
                "title": strip_html(e.findtext(ATOM + "title")),
                "link": link,
                "summary": strip_html(e.findtext(ATOM + "summary")),
                "content": strip_html(e.findtext(ATOM + "content")),
                "published": parse_date(e.findtext(ATOM + "published") or e.findtext(ATOM + "updated")),
            })
    else:                                                     # RSS 2.0: <rss><channel><item>...
        channel = root.find("channel")
        if channel is None:
            raise ValueError("This doesn't look like an RSS or Atom feed.")
        outlet = (channel.findtext("title") or "").strip()
        for item in channel.findall("item"):
            link = (item.findtext("link") or "").strip()
            stories.append({
                "id": (item.findtext("guid") or link or item.findtext("title") or "").strip(),
                "title": strip_html(item.findtext("title")),
                "link": link,
                "summary": strip_html(item.findtext("description")),
                "content": strip_html(item.findtext(CONTENT + "encoded")),
                "published": parse_date(item.findtext("pubDate")),
            })
    return outlet, [s for s in stories if s["id"] and s["title"]]


def story_text(story):
    """What the model reads: headline + summary, plus the start of the article if the summary is short."""
    text = story["title"]
    if story["summary"] and story["summary"] != story["title"]:
        text += ". " + story["summary"]
    if len(text) < 300 and story["content"]:
        text += " " + story["content"][:1200]
    return text[:2000]
