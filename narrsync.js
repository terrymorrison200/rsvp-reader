/* Swift Read — narration sync helpers (pure functions; browser global `NS`, also importable in node tests).
   Goal: word start times that follow the REAL audio of a chunk, so the highlight cannot drift.
   - envelope(): 10 ms loudness frames from decoded PCM
   - analyze(): finds speech onset/offset and the pauses actually present in the audio
   - timings(): estimated word times (letters + punctuation weights) re-anchored to the detected pauses */
(function (G) {
  const HOP = 0.01;
  // pause (in "letter units", ~0.05 s each) the voice normally makes after a word, by ending punctuation
  const gapType = (w, paraEnd) => paraEnd ? 4 : /[.!?…]["'”’)\]]*$/.test(w) ? 3 : /[;:—–]["'”’)\]]*$|-$/.test(w) ? 2 : /,["'”’)\]]*$/.test(w) ? 1 : 0;
  const GAPW = [0, 3, 4.5, 7, 12];       // estimate weights for the gap types
  const SKIP_SLOT = [0, 0.12, 0.6, 1.0, 1.5]; // cost of a text boundary the audio shows no pause for
  const wordW = (w) => 1.5 + w.replace(/[^\p{L}\p{N}]/gu, '').length + (/\d/.test(w) ? 2 : 0);

  function envelope(x, sr) {
    const hop = Math.max(1, Math.round(sr * HOP)), n = Math.floor(x.length / hop), db = new Float32Array(n);
    for (let f = 0; f < n; f++) { let s = 0; const a = f * hop, b = Math.min(x.length, a + hop * 2); for (let i = a; i < b; i++) s += x[i] * x[i]; db[f] = 10 * Math.log10(s / Math.max(1, b - a) + 1e-12); }
    return { db, hop: HOP };
  }
  // speech onset/offset + pauses (>= minPause) between them
  function analyze(env, minPause = 0.12) {
    const db = env.db, n = db.length; if (n < 5) return null;
    const sorted = Float32Array.from(db).sort(); const p = (q) => sorted[Math.min(n - 1, Math.floor(q * n))];
    const thr = Math.max(p(0.95) - 28, p(0.03) + 8); const voiced = (f) => db[f] > thr;
    let a = 0; while (a < n && !voiced(a)) a++; let b = n - 1; while (b > a && !voiced(b)) b--; if (b - a < 5) return null;
    const pauses = []; let f = a;
    while (f <= b) { if (voiced(f)) { f++; continue; } let g = f; while (g <= b && !voiced(g)) g++; if ((g - f) * HOP >= minPause) pauses.push({ s: f * HOP, e: g * HOP }); f = g; }
    return { on: a * HOP, off: (b + 1) * HOP, pauses, thr };
  }
  // words: [{t, para}] spoken words in order. an: analyze() result or null. dur: real audio duration (s).
  // Returns {t: start time per word, end, anchors}
  function timings(words, an, dur) {
    const n = words.length; if (!n) return { t: [], end: dur, anchors: 0 };
    const gt = words.map((w, k) => (k < n - 1 ? gapType(w.t, w.para) : 0)); const W = words.map((w) => wordW(w.t));
    const on = an ? an.on : 0, off = an ? an.off : dur;
    // Spread words i0..i1-1 over [t0,t1] by weight (holes === null: no audio analysis, punctuation weights stand in for pauses).
    const spread = (i0, i1, t0, t1, useGaps) => {
      const ww = []; for (let k = i0; k < i1; k++) ww.push(W[k] + (useGaps && k < i1 - 1 ? GAPW[gt[k]] : 0));
      const tot = ww.reduce((x, y) => x + y, 0) || 1; let c = 0; const out = []; for (let k = 0; k < ww.length; k++) { out.push(t0 + (c / tot) * (t1 - t0)); c += ww[k]; } return out;
    };
    // `holes` = detected pauses inside the span that match no punctuation (a hesitation, "did | not"). A pause is a word boundary, so
    // each one is snapped to the boundary whose predicted speech position is nearest, and the words on each side are laid out separately.
    const lay = (i0, i1, t0, t1, holes) => {
      if (!holes || !holes.length || i1 - i0 < 2) return spread(i0, i1, t0, t1, !holes);
      const hd = holes.reduce((x, h) => x + (h.e - h.s), 0), span = Math.max(0.01, t1 - t0 - hd); let tot = 0; for (let k = i0; k < i1; k++) tot += W[k];
      const cum = (k) => { let c = 0; for (let q = i0; q < k; q++) c += W[q]; return (c / tot) * span; };
      const out = []; let from = i0, a0 = t0, acc = 0;
      for (const h of holes) { const uh = h.s - t0 - acc; acc += h.e - h.s; let best = -1, bd = Infinity; for (let k = from + 1; k < i1; k++) { const d = Math.abs(cum(k) - uh); if (d < bd) { bd = d; best = k; } }
        if (best < 0) continue; out.push(...spread(from, best, a0, h.s, false)); from = best; a0 = h.e; }
      out.push(...spread(from, i1, a0, t1, false)); return out;
    };
    // 1) plain estimate over the speech span only (not the leading/trailing silence)
    if (!an || !an.pauses.length) return { t: spread(0, n, on, off, !an), end: dur, anchors: 0 };
    // 2) match detected pauses to text boundaries (monotone alignment on "speech-only" time, so pause lengths don't matter)
    const slots = []; let cw = 0; for (let k = 0; k < n - 1; k++) { cw += W[k]; if (gt[k]) slots.push({ k, g: gt[k], u: cw }); cw += 0; for (const s of slots.slice(-1)) if (s.k === k) s.u = cw; }
    const totW = W.reduce((x, y) => x + y, 0);
    const P = an.pauses; let spoke = 0, lastE = on; const ps = P.map((q) => { spoke += q.s - lastE; lastE = q.e; return { ...q, u: spoke, d: q.e - q.s }; });
    const speechTot = spoke + (off - lastE); const scale = speechTot / totW;
    const m = ps.length, s = slots.length, END = speechTot;
    // Viterbi over matched (pause, text-slot) pairs: each matched pair must keep the speech time since the previous pair
    // consistent with the text between them, so one wrong match can't shift everything after it. 0 = start, m+1/s+1 = end.
    const uP = (i) => (i === 0 ? 0 : i === m + 1 ? END : ps[i - 1].u), uS = (j) => (j === 0 ? 0 : j === s + 1 ? END : slots[j - 1].u * scale);
    const skipP = 0.5, MI = 5, MJ = 12;
    const pre = new Float64Array(s + 2); for (let j = 1; j <= s; j++) pre[j] = pre[j - 1] + SKIP_SLOT[slots[j - 1].g]; // prefix cost of skipping slots
    const idx = (i, j) => i * (s + 2) + j; const D = new Float64Array((m + 2) * (s + 2)).fill(Infinity), B = new Int32Array((m + 2) * (s + 2)).fill(-1); D[0] = 0;
    for (let i = 1; i <= m + 1; i++) for (let j = 1; j <= s + 1; j++) {
      const real = i <= m && j <= s; let pen = 0; if (real) { const q = ps[i - 1], t = slots[j - 1]; if (t.g >= 3 && q.d < 0.18) pen += 0.3; if (t.g <= 1 && q.d > 0.5) pen += 0.3; }
      if (i === m + 1 !== (j === s + 1)) continue; // end pairs with end
      let best = Infinity, bp = -1;
      for (let pi = Math.max(0, i - 1 - MI); pi < i; pi++) for (let pj = Math.max(0, j - 1 - MJ); pj < j; pj++) {
        const d = D[idx(pi, pj)]; if (d === Infinity) continue;
        const c = d + Math.abs((uP(i) - uP(pi)) - (uS(j) - uS(pj))) + skipP * (i - pi - 1) + (pre[j - 1] - pre[pj]) + pen;
        if (c < best) { best = c; bp = idx(pi, pj); }
      }
      D[idx(i, j)] = best; B[idx(i, j)] = bp;
    }
    const match = []; for (let c = B[idx(m + 1, s + 1)]; c > 0; c = B[c]) { const i = Math.floor(c / (s + 2)), j = c % (s + 2); if (i === 0) break; match.push([i - 1, j - 1]); }
    match.reverse();
    // 3) lay out each text segment between matched anchors across the real speech between the pauses
    const t = new Array(n); let w0 = 0, t0 = on; const used = new Set(match.map((x) => x[0]));
    const put = (k1, a, b) => { const holes = ps.filter((q, i) => !used.has(i) && q.s > a && q.e < b); const seg = lay(w0, k1, a, b, holes); for (let q = 0; q < seg.length; q++) t[w0 + q] = seg[q]; };
    for (const [pi, sj] of match) { const k = slots[sj].k + 1; put(k, t0, ps[pi].s); w0 = k; t0 = ps[pi].e; }
    put(n, t0, off);
    return { t, end: dur, anchors: match.length };
  }
  // Old behaviour, kept for comparison/tests: weights over the WHOLE file length, no pause detection
  const naive = (words, dur) => { const tot = words.reduce((a, w) => a + wordW(w.t) + GAPW[gapType(w.t, false)], 0); let c = 0; return words.map((w) => { const x = (c / tot) * dur; c += wordW(w.t) + GAPW[gapType(w.t, false)]; return x; }); };
  G.NS = { envelope, analyze, timings, naive, gapType, wordW, GAPW };
})(typeof window !== 'undefined' ? window : globalThis);
