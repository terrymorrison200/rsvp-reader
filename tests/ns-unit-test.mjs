// Unit test of the timing engine (narrsync.js) on synthetic voices with known word times. node tests/ns-unit-test.mjs
import '../narrsync.js'; import { synth } from './synth.mjs';
const LEX = 'the quiet river carried small boats beyond ancient stone bridges while travellers watched evening light settle across distant hills and farmers counted their harvest before winter arrived'.split(' ');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
function mkText(nPara, seed) { const paras = []; let c = seed; for (let p = 0; p < nPara; p++) { const n = 8 + ((c * 13 + p * 7) % 50); const w = []; for (let i = 0; i < n; i++) { let t = LEX[(c++ * 5 + i) % LEX.length]; if (i % 9 === 8) t += ','; if (i % 15 === 14) t += '.'; w.push(t); } w[w.length - 1] = w[w.length - 1].replace(/[,.]$/, '') + '.'; paras.push(w.join(' ')); } return paras.join('\n\n'); }
let worstNew = 0, worstOld = 0, tot = 0, sumNew = 0, sumOld = 0;
for (let seed = 0; seed < 12; seed++) {
  const text = mkText(1 + (seed % 5), seed * 31); const s = synth(text, { seed }); const pcm = new Int16Array(s.wav.buffer, s.wav.byteOffset + 44, (s.wav.length - 44) / 2); const x = Float32Array.from(pcm, (v) => v / 32768);
  const words = text.split(/\s+/).map((t, k, a) => ({ t, para: /[.]$/.test(t) && text.includes(t + '\n\n') && false })); // para flags from the text below
  const re = /\S+/g; let m; const ws = []; while ((m = re.exec(text))) ws.push({ t: m[0], para: /^\s*\n\s*\n/.test(text.slice(m.index + m[0].length)) });
  const an = NS.analyze(NS.envelope(x, 16000)); const r = NS.timings(ws, an, s.dur); const old = NS.naive(ws, s.dur);
  const avgWord = 0.3; const eN = r.t.map((t, i) => Math.abs(t - s.starts[i])), eO = old.map((t, i) => Math.abs(t - s.starts[i]));
  worstNew = Math.max(worstNew, ...eN); worstOld = Math.max(worstOld, ...eO); tot += eN.length; sumNew += eN.reduce((a, b) => a + b, 0); sumOld += eO.reduce((a, b) => a + b, 0);
  console.log(`  voice ${seed}: ${ws.length} words, ${s.dur.toFixed(0)} s | old max ${Math.max(...eO).toFixed(2)} s, new max ${Math.max(...eN).toFixed(2)} s (anchors ${r.anchors}/${an.pauses.length} pauses)`);
}
console.log(`  mean error old ${(sumOld / tot).toFixed(2)} s, new ${(sumNew / tot).toFixed(2)} s; worst old ${worstOld.toFixed(2)} s, new ${worstNew.toFixed(2)} s`);
ok(sumNew / tot < 0.08 && worstNew <= 0.6, 'word start times follow the real audio: mean error < 0.08 s, worst < 0.6 s (~2 words) on every synthetic voice (mean ' + (sumNew / tot).toFixed(2) + ' s, worst ' + worstNew.toFixed(2) + ' s)');
ok(worstOld > 0.6, 'the old whole-file estimate is off by >0.6 s on the same audio (worst ' + worstOld.toFixed(2) + ' s) — this is the drift');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
