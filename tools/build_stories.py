#!/usr/bin/env python3
"""Build stories.json: word counts for the top Gutenberg 'short stories' books (for reading-time estimates).
Usage: python3 tools/build_stories.py [pages=4]"""
import json, re, sys, urllib.request, urllib.parse, os, datetime
UA = {'User-Agent': 'Mozilla/5.0 SwiftRead-builder'}
def get(u, t=120): return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=t).read()
pages = int(sys.argv[1]) if len(sys.argv) > 1 else 4
out = os.path.join(os.path.dirname(__file__), '..', 'stories.json')
res = json.load(open(out)) if os.path.exists(out) else {'words': {}}
url = 'https://gutendex.com/books/?languages=en&topic=short%20stories'; books = []
for _ in range(pages):
    d = json.loads(get(url)); books += d['results']; url = d['next']
    if not url: break
for b in books:
    k = str(b['id'])
    if k in res['words']: continue
    try:
        t = get(f'https://cors.eu.org/https://gutenberg.pglaf.org/cache/epub/{k}/pg{k}.txt').decode('utf-8', 'replace')
        s = t.find('*** START OF'); e = t.find('*** END OF'); body = t[t.find('\n', s) + 1:e] if s >= 0 else t
        res['words'][k] = len(body.split()); print(k, b['title'][:50], res['words'][k], file=sys.stderr)
    except Exception as ex: print('fail', k, ex, file=sys.stderr)
res['books'] = [{'id': b['id'], 'title': b['title'], 'authors': [{'name': a['name']} for a in b['authors']], 'download_count': b['download_count'], 'formats': {'image/jpeg': b['formats'].get('image/jpeg', '')}, 'subjects': b.get('subjects', [])[:6], 'bookshelves': b.get('bookshelves', [])[:4], 'translators': b.get('translators', [])} for b in books]
res['next'] = url
res['generated'] = datetime.date.today().isoformat(); res['source'] = 'Project Gutenberg plain-text files via Gutendex topic "short stories"'
json.dump(res, open(out, 'w'))
