#!/usr/bin/env python3
"""Regenerate church/come-follow-me-<year>.json and church/conference-latest.json from churchofjesuschrist.org.
Usage: python3 tools/build_church.py [--cfm-year 2026] [--conf 2026/10]   (default conf = newest available)"""
import json, re, html, sys, urllib.request, datetime, os, argparse
API = 'https://www.churchofjesuschrist.org/study/api/v3/language-pages/type/content?lang=eng&uri='
SITE = 'https://www.churchofjesuschrist.org/study'
def get(uri):
    req = urllib.request.Request(API + uri, headers={'User-Agent': 'Mozilla/5.0 SwiftRead-builder'})
    return json.load(urllib.request.urlopen(req, timeout=60))
def txt(h): return html.unescape(re.sub(r'<[^>]+>', ' ', h)).replace('\xa0', ' ')
def words(body):
    body = re.sub(r'<(script|style|footer)[\s\S]*?</\1>', '', body)
    return len(txt(body).split())
MONTHS = {m: i for i, m in enumerate(['January','February','March','April','May','June','July','August','September','October','November','December'], 1)}
OT = {'Genesis':'gen','Exodus':'ex','Leviticus':'lev','Numbers':'num','Deuteronomy':'deut','Joshua':'josh','Judges':'judg','Ruth':'ruth','1 Samuel':'1-sam','2 Samuel':'2-sam','1 Kings':'1-kgs','2 Kings':'2-kgs','1 Chronicles':'1-chr','2 Chronicles':'2-chr','Ezra':'ezra','Nehemiah':'neh','Esther':'esth','Job':'job','Psalms':'ps','Proverbs':'prov','Ecclesiastes':'eccl','Isaiah':'isa','Jeremiah':'jer','Lamentations':'lam','Ezekiel':'ezek','Daniel':'dan','Hosea':'hosea','Joel':'joel','Amos':'amos','Obadiah':'obad','Jonah':'jonah','Micah':'micah','Nahum':'nahum','Habakkuk':'hab','Zephaniah':'zeph','Haggai':'hag','Zechariah':'zech','Malachi':'mal'}
PGP = {'Moses':'moses','Abraham':'abr'}
WHOLE = {'Ruth':4,'Esther':10,'Joel':3,'Amos':9,'Obadiah':1,'Jonah':4,'Micah':7,'Nahum':3,'Habakkuk':3,'Zephaniah':3,'Malachi':4}
def parse_refs(s):
    """'Isaiah 58–66' / 'Psalms 102–3; 110' -> [{book, vol, abbr, chapter}]"""
    out = []; book = None
    for part in [p.strip() for p in s.split(';') if p.strip()]:
        m = re.match(r'^((?:\d )?[A-Z][a-z]+)\s*(.*)$', part)
        if m and (m.group(1) in OT or m.group(1) in PGP): book, rng = m.group(1), m.group(2)
        else: rng = part
        if not book: continue
        if not rng:
            if book in WHOLE: rng = '1–%d' % WHOLE[book]
            else: continue
        a, _, b = rng.replace('-', '–').partition('–'); a = int(a)
        if b:
            b = int(b)
            if b < a: b = int(str(a)[:len(str(a)) - len(str(b))] + str(b))  # 102–3 -> 103
        else: b = a
        vol = 'ot' if book in OT else 'pgp'; ab = OT.get(book) or PGP[book]
        out += [{'book': book, 'vol': vol, 'abbr': ab, 'chapter': c} for c in range(a, b + 1)]
    return out
def build_cfm(year):
    slug = f'come-follow-me-for-home-and-church-old-testament-{year}'
    d = get('/manual/' + slug); body = d['content']['body']; weeks = []
    for m in re.finditer(r'href="/study/manual/%s/(\d+)[^"]*"[^>]*>(.*?)</a>' % slug, body, re.S):
        n, inner = m.group(1), m.group(2)
        parts = [p.strip() for p in txt(re.sub(r'</p>', '|', inner)).split('|') if p.strip()]
        if len(parts) < 2 or not re.match(r'^(%s) \d' % '|'.join(MONTHS), parts[0]): continue
        dr, refs = parts[0], parts[1]
        dm = re.match(r'(\w+) (\d+)–(?:(\w+) )?(\d+)', dr)
        m1, d1, m2, d2 = MONTHS[dm.group(1)], int(dm.group(2)), MONTHS[dm.group(3) or dm.group(1)], int(dm.group(4))
        y1 = year - 1 if m1 == 12 and n == '01' else year
        start = datetime.date(y1, m1, d1); end = datetime.date(y1 + (1 if m2 < m1 else 0), m2, d2)
        page = get(f'/manual/{slug}/{n}')
        title = txt(page['meta']['title']).strip()
        tm = re.search(r'[“"](.+?)[”"]', title)
        weeks.append({'week': int(n), 'start': start.isoformat(), 'end': end.isoformat(), 'dates': dr, 'title': tm.group(1) if tm else refs,
                      'reading': refs, 'chapters': parse_refs(refs), 'lessonUri': f'/manual/{slug}/{n}', 'url': f'{SITE}/manual/{slug}/{n}?lang=eng',
                      'lessonWords': words(page['content']['body'])})
        print(n, dr, '|', weeks[-1]['title'], '|', refs, len(weeks[-1]['chapters']), file=sys.stderr)
    return {'year': year, 'manual': d['meta']['title'], 'source': f'{SITE}/manual/{slug}?lang=eng', 'generated': datetime.date.today().isoformat(), 'weeks': weeks}
def latest_conf():
    t = datetime.date.today()
    for y, mo in [(t.year, 10), (t.year, 4), (t.year - 1, 10)]:
        if datetime.date(y, mo, 1) > t: continue
        try:
            d = get(f'/general-conference/{y}/{mo:02d}')
            if '/talk' in d['content']['body'] or 'session' in d['content']['body']: return f'{y}/{mo:02d}'
        except Exception: pass
def build_conf(ym):
    d = get('/general-conference/' + ym); body = d['content']['body']; talks = []; session = ''
    for m in re.finditer(r'href="/study/general-conference/%s/([^"?]+)[^"]*"[^>]*>(.*?)</a>' % ym, body, re.S):
        slug = m.group(1); parts = [p.strip() for p in txt(re.sub(r'</p>|</h\d>|</span>', '|', m.group(2))).split('|') if p.strip()]
        if slug.endswith('session'): session = parts[0]; continue
        if len(parts) < 2: continue
        speaker, title = parts[0], parts[1]
        if re.match(r'^(Sustaining|Church Auditing)', title):
            continue
        try: tp = get(f'/general-conference/{ym}/{slug}'); w = words(tp['content']['body']); audio = next((a['mediaUrl'] for a in tp['meta'].get('audio') or [] if a.get('variant') == 'audio'), '')
        except Exception: w = 0; audio = ''
        talks.append({'id': f'gc-{ym.replace("/", "-")}-{slug}', 'speaker': speaker, 'title': title, 'session': session, 'summary': parts[2] if len(parts) > 2 else '',
                      'uri': f'/general-conference/{ym}/{slug}', 'url': f'{SITE}/general-conference/{ym}/{slug}?lang=eng', 'words': w, 'audio': audio})
        print(session, '|', speaker, '|', title, w, file=sys.stderr)
    return {'conference': d['meta']['title'], 'id': ym, 'source': f'{SITE}/general-conference/{ym}?lang=eng', 'generated': datetime.date.today().isoformat(), 'talks': talks}
if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--cfm-year', type=int, default=datetime.date.today().year); ap.add_argument('--conf'); ap.add_argument('--skip-cfm', action='store_true')
    a = ap.parse_args(); root = os.path.join(os.path.dirname(__file__), '..', 'church'); os.makedirs(root, exist_ok=True)
    if not a.skip_cfm:
        json.dump(build_cfm(a.cfm_year), open(os.path.join(root, f'come-follow-me-{a.cfm_year}.json'), 'w'), ensure_ascii=False, indent=1)
    ym = a.conf or latest_conf()
    json.dump(build_conf(ym), open(os.path.join(root, 'conference-latest.json'), 'w'), ensure_ascii=False, indent=1)
