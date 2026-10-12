#!/usr/bin/env python3
"""Word-level alignment of conference talk audio to the app's RSVP tokens.
1) node tools/talk_tokens.mjs  (dumps tokens)   2) /home/box/fw/bin/python tools/align_talks.py
Writes talks/<id>.json = {id, audio, count, wpm, end, t:[start ms per token], matched}"""
import json, os, re, sys, glob, difflib, urllib.request
from faster_whisper import WhisperModel
model = WhisperModel(os.environ.get('WHISPER_MODEL', 'base.en'), device='cpu', compute_type='float32', cpu_threads=8)
norm = lambda w: re.sub(r'[^a-z0-9]', '', w.lower().replace('’', "'"))
os.makedirs('talks', exist_ok=True); os.makedirs('/tmp/talkmp3', exist_ok=True)
for f in sorted(glob.glob('/tmp/talktok/*.json')):
    t = json.load(open(f)); out = f"talks/{t['id']}.json"
    if os.path.exists(out) or not t.get('audio'): continue
    mp3 = f"/tmp/talkmp3/{t['id']}.mp3"
    if not os.path.exists(mp3): urllib.request.urlretrieve(t['audio'], mp3)
    import subprocess, numpy as np
    pcm = np.frombuffer(subprocess.run(['ffmpeg', '-v', 'quiet', '-i', mp3, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], capture_output=True, check=True).stdout, np.int16).astype(np.float32) / 32768
    segs, info = model.transcribe(pcm, word_timestamps=True, beam_size=1, vad_filter=False, condition_on_previous_text=False)
    hw = [(norm(w.word), w.start, w.end) for s in segs for w in s.words]; hw = [x for x in hw if x[0]]
    toks = t['tokens']; tn = [norm(x) for x in toks]
    sm = difflib.SequenceMatcher(None, tn, [x[0] for x in hw], autojunk=False)
    st = [None] * len(toks)
    for a, b, n in sm.get_matching_blocks():
        for k in range(n): st[a + k] = hw[b + k][1]
    matched = sum(x is not None for x in st)
    # interpolate gaps; tokens before first match (title/byline not spoken) get the first time
    known = [i for i, x in enumerate(st) if x is not None]
    for i in range(len(st)):
        if st[i] is not None: continue
        prev = max([k for k in known if k < i], default=None); nxt = min([k for k in known if k > i], default=None)
        if prev is None: st[i] = st[nxt] if nxt is not None else 0
        elif nxt is None: st[i] = st[prev] + 0.3 * (i - prev)
        else: st[i] = st[prev] + (st[nxt] - st[prev]) * (i - prev) / (nxt - prev)
    for i in range(1, len(st)): st[i] = max(st[i], st[i - 1])
    dur = info.duration; spoken = max(1, matched)
    res = {'id': t['id'], 'audio': t['audio'], 'count': len(toks), 'matched': round(matched / len(toks), 3), 'wpm': round(spoken / (dur / 60)), 'end': int(dur * 1000), 't': [int(x * 1000) for x in st]}
    json.dump(res, open(out, 'w'), separators=(',', ':'))
    print(t['id'], len(toks), 'matched %.1f%%' % (100 * matched / len(toks)), 'wpm', res['wpm'], os.path.getsize(out), file=sys.stderr, flush=True)
