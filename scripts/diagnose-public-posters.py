"""Probe only public, fixed Trakt samples. Never reads app/account credentials."""
import json
import re
import urllib.error
import urllib.request

SAMPLE = "https://walter-r2.trakt.tv/images/movies/000/012/601/posters/thumb/e0d9dd35c5.jpg.webp"
ORIGIN = "https://templehao.github.io"


def probe(url, headers=None):
    try:
        request = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read(2 * 1024 * 1024 + 1)
            return {
                "status": response.status,
                "contentType": response.headers.get("Content-Type"),
                "acao": response.headers.get("Access-Control-Allow-Origin"),
                "corp": response.headers.get("Cross-Origin-Resource-Policy"),
                "bytes": len(body),
                "webp": body[:4] == b"RIFF" and body[8:12] == b"WEBP",
            }
    except urllib.error.HTTPError as error:
        return {"status": error.code, "contentType": error.headers.get("Content-Type")}
    except Exception as error:
        return {"failure": type(error).__name__}


result = {"documentedSample": {
    "cacheDownload": probe(SAMPLE),
    "corsDownload": probe(SAMPLE, {"Origin": ORIGIN}),
}}
# The public title page may reveal a current poster when the guide sample is old.
try:
    with urllib.request.urlopen("https://trakt.tv/movies/inception-2010", timeout=20) as response:
        html = response.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
    posters = re.findall(r"(?:https:)?//walter-r2\.trakt\.tv/images/[a-zA-Z0-9/_-]+/posters/[a-zA-Z0-9/_-]+\.(?:jpg|png|jpeg)\.webp", html)
    result["publicTitlePage"] = {"status": 200, "posterLinks": len(set(posters))}
    if posters:
        url = posters[0] if posters[0].startswith("https:") else "https:" + posters[0]
        result["currentPublicPoster"] = probe(url)
except urllib.error.HTTPError as error:
    result["publicTitlePage"] = {"status": error.code}
except Exception as error:
    result["publicTitlePage"] = {"failure": type(error).__name__}
print(json.dumps(result, ensure_ascii=False))
