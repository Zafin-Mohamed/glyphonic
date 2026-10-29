// glyphFormat.js
// Automatically creates a light show from the song.
//
// Idea: people feel a song's beat in its drums, not in its singing or its
// sustained notes. So we
//   1. turn the song into a picture of its sound over time (a spectrogram),
//   2. keep only the sharp, drum-like parts and throw away the held, melodic
//      parts (vocals, pads, held guitar notes),
//   3. find the moments where those drum-like sounds suddenly get stronger
//      in the low, middle and high ranges,
//   4. find the song's beat, so a repeating drum pattern always lights the
//      same zones in the same order,
//   5. find big moments (a drop, or beats starting after a quiet part) and
//      play a light sweep from top to bottom there, and
//   6. send everything to the zones of the Glyph Bar.

// ---------- settings ----------

const ANALYSIS_RATE = 22050;  // we analyse a smaller copy of the song, it's faster
const FFT_SIZE = 1024;        // length of each "slice" of sound we look at (about 46 ms)
const HOP_SIZE = 256;         // how far we move between slices (about 11.6 ms)
const MAX_BIN = 480;          // ignore anything above about 10 kHz
const ONSET_OFFSET = 0.0;     // seconds to move every detected hit earlier (timing fine-tune)
const HELD_NOTE_HALF = 15;    // how far (in slices) we look sideways to spot held notes
const DRUM_HIT_HALF = 8;      // how far (in frequency bins) we look up and down to spot drum hits
const SLICES_PER_SECOND = ANALYSIS_RATE / HOP_SIZE;

// How many frequency "bins" belong to each range (one bin is about 21.5 Hz).
const BAND_BINS = {
  bass: [1, 8],       // roughly 20 - 170 Hz     (kick drum, bass)
  mid: [9, 140],      // roughly 190 - 3000 Hz   (snare, claps)
  treble: [232, 465], // roughly 5000 - 10000 Hz (hi-hats, cymbals)
  kick: [1, 4],       // roughly 20 - 90 Hz      (only used to find drops: snares don't reach this low)
};

// How picky each range is. A higher "sensitivity" number means fewer hits.
const BAND_SETTINGS = {
  bass:   { sensitivity: 2.0, peakRadius: 4, minGap: 0.18 },
  mid:    { sensitivity: 2.4, peakRadius: 3, minGap: 0.12 },
  treble: { sensitivity: 2.6, peakRadius: 2, minGap: 0.08 },
  kick:   { sensitivity: 2.0, peakRadius: 4, minGap: 0.18 },
};

// "Calm" gives fewer lights, "Busy" gives more.
const DENSITY_FACTOR = { calm: 1.25, balanced: 1.0, busy: 0.7 };

// Weaker hits are a bit dimmer, clear beats are full brightness. This is the
// share of full brightness the weakest hits get. Set it to 1 to make every
// hit equally bright.
const MIN_BRIGHTNESS_SHARE = 0.5;

// Drop sweeps: a wave of light from the top zone to the bottom one.
const SWEEP_DELAY = 0.07;              // seconds between one zone and the next
const SWEEP_GLOW = [1, 0.73, 0.49, 0.29, 0.15]; // how a zone fades after the wave passes (share of full brightness)
const SWEEP_GLOW_FRAMES = 3;           // each step of the fade lasts this many frames
const DROP_HUGE_JUMP_DB = 11;          // a jump in volume this big (in decibels) also counts as a drop
const DROP_MIN_GAP = 8;                // seconds between two sweeps, at least
const REPEAT_EASIER = 0.75;            // hits that fit the repeating pattern need less proof
const REPEAT_HARDER = 1.3;             // one-off hits need more proof

// ---------- FFT: turns a slice of sound into its frequencies ----------

function makeFFT(n) {
  const levels = Math.log2(n);
  const cosTable = new Float64Array(n / 2);
  const sinTable = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosTable[i] = Math.cos((2 * Math.PI * i) / n);
    sinTable[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const reversed = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) if (i & (1 << b)) r |= 1 << (levels - 1 - b);
    reversed[i] = r;
  }

  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = reversed[i];
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cosTable[k] + im[l] * sinTable[k];
          const tim = -re[l] * sinTable[k] + im[l] * cosTable[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

const waitForBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

// Builds the spectrogram: for every slice of sound, how strong each frequency is.
// Result: a flat list, frames x MAX_BIN, row by row. We also note how loud each
// slice is overall ("energy"), for finding quiet parts and drops.
async function computeSpectrogram(samples) {
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP_SIZE) + 1);
  const spec = new Float32Array(frames * MAX_BIN);
  const energy = new Float32Array(frames);
  const fft = makeFFT(FFT_SIZE);
  const window = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let t = 0; t < frames; t++) {
    const start = t * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) { re[i] = samples[start + i] * window[i]; im[i] = 0; }
    fft(re, im);
    const row = t * MAX_BIN;
    let power = 0;
    for (let k = 0; k < MAX_BIN; k++) {
      const magnitude = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      spec[row + k] = magnitude;
      if (k > 0) power += magnitude * magnitude;
    }
    energy[t] = power;
    if (t % 1500 === 1499) await waitForBrowser(); // keep the page responsive
  }
  return { spec, frames, energy };
}

// ---------- median filter: the trick that separates drums from vocals ----------
// Sliding median along one line of numbers (a row or a column of the spectrogram).
function medianAlong(src, start, stride, length, half, dst, dstStart, dstStride, win) {
  let count = 0;
  const insert = (v) => {
    let lo = 0, hi = count;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (win[mid] < v) lo = mid + 1; else hi = mid; }
    win.copyWithin(lo + 1, lo, count); win[lo] = v; count++;
  };
  const remove = (v) => {
    let lo = 0, hi = count;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (win[mid] < v) lo = mid + 1; else hi = mid; }
    win.copyWithin(lo, lo + 1, count); count--;
  };
  for (let i = 0; i <= Math.min(half, length - 1); i++) insert(src[start + i * stride]);
  for (let i = 0; i < length; i++) {
    dst[dstStart + i * dstStride] = win[(count - 1) >> 1];
    const add = i + half + 1;
    if (add < length) insert(src[start + add * stride]);
    const rem = i - half;
    if (rem >= 0) remove(src[start + rem * stride]);
  }
}

// Keeps only the drum-like (percussive) part of the spectrogram.
//  - A held note (vocal, pad) is long in time: smoothing along TIME keeps it and removes drums.
//  - A drum hit is tall in frequency: smoothing along FREQUENCY keeps it and removes held notes.
// Comparing the two tells us how "drum-like" each point is.
async function keepPercussive(spec, frames) {
  const timeHalf = HELD_NOTE_HALF;
  const freqHalf = DRUM_HIT_HALF;
  const held = new Float32Array(spec.length);
  const winTime = new Float32Array(timeHalf * 2 + 2);
  for (let k = 0; k < MAX_BIN; k++) {
    medianAlong(spec, k, MAX_BIN, frames, timeHalf, held, k, MAX_BIN, winTime);
    if (k % 120 === 119) await waitForBrowser();
  }

  const winFreq = new Float32Array(freqHalf * 2 + 2);
  const drumRow = new Float32Array(MAX_BIN);
  for (let t = 0; t < frames; t++) {
    const row = t * MAX_BIN;
    medianAlong(spec, row, 1, MAX_BIN, freqHalf, drumRow, 0, 1, winFreq);
    for (let k = 0; k < MAX_BIN; k++) {
      const h = held[row + k];
      const p = drumRow[k];
      spec[row + k] *= (p * p) / (h * h + p * p + 1e-12); // soft mask: 1 = drum-like, 0 = held note
    }
    if (t % 1500 === 1499) await waitForBrowser();
  }
}

// ---------- finding the hits ----------

// For each frame, how much did the drum-like sound in this range just increase?
function bandFlux(spec, frames, bandName) {
  const [fromBin, toBin] = BAND_BINS[bandName];
  const flux = new Float32Array(frames);
  const GAIN = 20; // squashes loud and quiet parts closer together (like hearing does)
  for (let t = 1; t < frames; t++) {
    let sum = 0;
    const row = t * MAX_BIN;
    const prev = (t - 1) * MAX_BIN;
    for (let k = fromBin; k <= toBin; k++) {
      const diff = Math.log1p(GAIN * spec[row + k]) - Math.log1p(GAIN * spec[prev + k]);
      if (diff > 0) sum += diff;
    }
    flux[t] = sum;
  }
  return flux;
}

const frameToSeconds = (frame) => (frame * HOP_SIZE + FFT_SIZE / 2) / ANALYSIS_RATE;

// Picks the moments where the flux jumps up clearly higher than it normally is nearby.
function pickHits(flux, bandName, densityFactor, multiplier = null) {
  const { sensitivity, peakRadius, minGap } = BAND_SETTINGS[bandName];
  const frames = flux.length;
  const frameSeconds = HOP_SIZE / ANALYSIS_RATE;

  // running average and spread of the flux over about +/- 0.75 s
  const radius = Math.round(0.75 / frameSeconds);
  const sum = new Float64Array(frames + 1);
  const sumSq = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) { sum[i + 1] = sum[i] + flux[i]; sumSq[i + 1] = sumSq[i] + flux[i] * flux[i]; }

  const sorted = Float32Array.from(flux).sort();
  const loudFloor = 0.08 * sorted[Math.floor(frames * 0.99)]; // never react to near-silence

  const hits = [];
  let lastIndex = -1e9;
  for (let t = 1; t < frames - 1; t++) {
    const a = Math.max(0, t - radius), b = Math.min(frames, t + radius + 1);
    const n = b - a;
    const mean = (sum[b] - sum[a]) / n;
    const std = Math.sqrt(Math.max(0, (sumSq[b] - sumSq[a]) / n - mean * mean));
    const pickiness = multiplier ? multiplier[t] : 1;
    const threshold = Math.max(mean + sensitivity * densityFactor * std * pickiness, loudFloor);
    if (flux[t] <= threshold) continue;

    let isPeak = true;
    for (let j = Math.max(1, t - peakRadius); j <= Math.min(frames - 1, t + peakRadius); j++) {
      if (flux[j] > flux[t]) { isPeak = false; break; }
    }
    if (!isPeak) continue;

    // Refine the time between frames (parabola through the 3 points around the peak).
    const l = flux[t - 1], c = flux[t], r = flux[t + 1];
    const denom = l - 2 * c + r;
    const shift = denom !== 0 ? (0.5 * (l - r)) / denom : 0;
    const seconds = frameToSeconds(t + shift) - ONSET_OFFSET;

    const strength = flux[t] / threshold; // 1 = just above the bar, 2 = twice as high
    if ((t - lastIndex) * frameSeconds < minGap) {
      // too close to the previous hit: keep only the stronger one
      if (hits.length && strength > hits[hits.length - 1].strength) hits[hits.length - 1] = { seconds, strength };
    } else {
      hits.push({ seconds, strength });
    }
    lastIndex = t;
  }
  return hits.map((h) => ({ seconds: Math.max(0, h.seconds), strength: h.strength }));
}

// ---------- finding the beat ----------

// One curve that is high wherever something starts, in any range.
function buildOnsetEnvelope(flux) {
  const frames = flux.bass.length;
  const raw = new Float32Array(frames);
  for (const name of ['bass', 'mid', 'treble']) {
    const sorted = Float32Array.from(flux[name]).sort();
    const scale = sorted[Math.floor(frames * 0.95)] || 1;
    for (let t = 0; t < frames; t++) raw[t] += flux[name][t] / scale;
  }
  // subtract the local average so only the peaks remain
  const radius = 21;
  const cumulative = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) cumulative[i + 1] = cumulative[i] + raw[i];
  const out = new Float32Array(frames);
  let sumSq = 0;
  for (let t = 0; t < frames; t++) {
    const a = Math.max(0, t - radius), b = Math.min(frames, t + radius + 1);
    const value = Math.max(0, raw[t] - (cumulative[b] - cumulative[a]) / (b - a));
    out[t] = value; sumSq += value * value;
  }
  const spread = Math.sqrt(sumSq / frames) || 1;
  for (let t = 0; t < frames; t++) out[t] /= spread;
  return out;
}

// How many slices are there between two beats? Found by checking after how
// long the pattern of onsets repeats itself (autocorrelation).
function estimateBeatPeriod(onset) {
  const n = onset.length;
  const minLag = Math.round((SLICES_PER_SECOND * 60) / 190); // fastest tempo we look for: 190 BPM
  const maxLag = Math.round((SLICES_PER_SECOND * 60) / 65);  // slowest: 65 BPM
  const longest = Math.min(n - 1, Math.round(maxLag * 5.5));
  if (longest < maxLag * 4) return 0;

  const similarity = new Float64Array(longest + 2);
  for (let lag = minLag; lag <= longest; lag++) {
    let sum = 0;
    for (let t = 0; t + lag < n; t++) sum += onset[t] * onset[t + lag];
    similarity[lag] = sum / (n - lag);
  }
  const similarAt = (lag) => { // similarity at a lag that may fall between two whole numbers
    const low = Math.floor(lag), fraction = lag - low;
    return similarity[low] * (1 - fraction) + (similarity[low + 1] || 0) * fraction;
  };

  let bestLag = 0, bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (SLICES_PER_SECOND * 60) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.75, 2)); // everyday tempos are more likely
    const score = (similarity[lag] + 0.5 * (similarity[2 * lag] || 0) + 0.25 * (similarity[4 * lag] || 0)) * prior;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag <= minLag || bestLag >= maxLag) return bestLag;
  const l = similarity[bestLag - 1], c = similarity[bestLag], r = similarity[bestLag + 1];
  const denom = l - 2 * c + r;
  const period = bestLag + (denom !== 0 ? (0.5 * (l - r)) / denom : 0);

  // Double check: a tempo that is out by a simple ratio (like 4/3) can look right.
  // The right one makes a whole bar (4 beats) repeat the most strongly.
  let chosen = period, chosenScore = similarAt(4 * period);
  for (const ratio of [4 / 3, 3 / 4, 2, 0.5]) {
    const candidate = period * ratio;
    if (candidate < minLag || candidate > maxLag || 4 * candidate > longest) continue;
    const score = similarAt(4 * candidate);
    if (score > chosenScore * 1.1) { chosen = candidate; chosenScore = score; }
  }
  return chosen;
}

// Places beats along the song so that they land on onsets and stay about one
// beat apart (dynamic programming: it finds the best chain over the whole song).
function trackBeats(onset, period) {
  const n = onset.length;
  const smooth = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let sum = 0;
    for (let i = -3; i <= 3; i++) if (t + i >= 0 && t + i < n) sum += onset[t + i] * Math.exp(-0.5 * (i / 1.5) * (i / 1.5));
    smooth[t] = sum;
  }

  const best = new Float64Array(n);
  const from = new Int32Array(n).fill(-1);
  const TIGHTNESS = 100; // how strongly beats are pulled towards equal spacing
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, Math.round(t - 2 * period));
    const hi = Math.round(t - period / 2);
    let top = 0, topIndex = -1;
    for (let u = lo; u <= hi; u++) {
      const d = Math.log((t - u) / period);
      const value = best[u] - TIGHTNESS * d * d;
      if (value > top) { top = value; topIndex = u; }
    }
    best[t] = smooth[t] + top;
    from[t] = topIndex;
  }

  let end = Math.max(0, n - Math.round(period));
  for (let t = end; t < n; t++) if (best[t] > best[end]) end = t;
  const chain = [];
  for (let t = end; t >= 0; t = from[t]) { chain.push(t); if (from[t] < 0) break; }
  return chain.reverse();
}

// Finds the beats and works out where in a 4-beat bar every moment falls.
function findBeats(flux) {
  const onset = buildOnsetEnvelope(flux);
  const period = estimateBeatPeriod(onset);
  if (!period) return { confident: false };

  const chain = trackBeats(onset, period);
  if (chain.length < 8) return { confident: false };
  const times = chain.map(frameToSeconds);
  const periodSeconds = period / SLICES_PER_SECOND;

  // how regular are the beats, and do they land on real onsets?
  let regular = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - times[i - 1] - periodSeconds) < 0.2 * periodSeconds) regular++;
  const regularity = regular / (times.length - 1);
  let onBeat = 0, overall = 0;
  for (const t of chain) onBeat += onset[t];
  for (let t = 0; t < onset.length; t++) overall += onset[t];
  const strength = (onBeat / chain.length) / (overall / onset.length || 1);
  const confident = regularity >= 0.7 && strength >= 1.3;

  // beat numbers: 0, 1, 2, ... (a missing beat in the chain counts as a gap)
  const numbers = [0];
  for (let i = 1; i < times.length; i++) {
    numbers.push(numbers[i - 1] + Math.max(1, Math.round((times[i] - times[i - 1]) / periodSeconds)));
  }

  // which of the 4 beats in a bar has the strongest low sounds? call it beat 1
  const weight = [0, 0, 0, 0];
  chain.forEach((t, i) => { weight[numbers[i] % 4] += flux.bass[t] + flux.mid[t]; });
  const barStart = weight.indexOf(Math.max(...weight));

  return { confident, times, numbers, barStart, periodSeconds, bpm: 60 / periodSeconds, regularity, strength };
}

// Which beat of the song is this moment? (a number with decimals, 12.5 = halfway between beat 12 and 13)
function beatNumberAt(seconds, beats) {
  const { times, numbers } = beats;
  const last = times.length - 1;
  if (seconds <= times[0]) return numbers[0] - (times[0] - seconds) / (times[1] - times[0]);
  if (seconds >= times[last]) return numbers[last] + (seconds - times[last]) / (times[last] - times[last - 1]);
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= seconds) lo = mid; else hi = mid; }
  return numbers[lo] + ((seconds - times[lo]) / (times[hi] - times[lo])) * (numbers[hi] - numbers[lo]);
}

// Which bar is this moment in, and which sixteenth note of that bar (0 to 15)?
function barAndSlot(seconds, beats) {
  const sixteenths = Math.round((beatNumberAt(seconds, beats) - beats.barStart) * 4);
  return { bar: Math.floor(sixteenths / 16), slot: ((sixteenths % 16) + 16) % 16 };
}

const slotInBar = (seconds, beats) => barAndSlot(seconds, beats).slot;

// Repeat-aware detection. If a slot of the bar has had a hit in most of the
// nearby bars, a hit there is very likely real, so we make it easier to
// accept. If hardly any nearby bar has a hit there, it is probably a one-off
// (often a singer), so we make it harder. Returns a number for every slice
// that scales how picky pickHits is.
function repeatMultipliers(hits, beats, frames) {
  const barRows = new Map();
  for (const hit of hits) {
    const { bar, slot } = barAndSlot(hit.seconds, beats);
    if (!barRows.has(bar)) barRows.set(bar, new Uint8Array(16));
    barRows.get(bar)[slot] = 1;
  }
  const isActive = (row) => row && row.reduce((a, b) => a + b, 0) >= 3; // a bar with a real pattern in it

  const multiplier = new Float32Array(frames).fill(1);
  for (let t = 0; t < frames; t++) {
    const { bar, slot } = barAndSlot(frameToSeconds(t), beats);
    let seen = 0, total = 0;
    for (let b = bar - 4; b <= bar + 4; b++) {
      if (b === bar) continue; // a hit must not vouch for itself
      const row = barRows.get(b);
      if (!isActive(row)) continue;
      total++;
      seen += row[slot];
    }
    if (total < 3) continue;
    const rate = seen / total;
    if (rate >= 0.7) multiplier[t] = REPEAT_EASIER;
    else if (rate <= 0.15) multiplier[t] = REPEAT_HARDER;
  }
  return multiplier;
}

// ---------- finding big moments and quiet parts ----------

// Loudness over time, in decibels, from the energy of each slice.
function levelDb(cumulative, from, to) {
  const a = Math.max(0, Math.min(cumulative.length - 1, from));
  const b = Math.max(0, Math.min(cumulative.length - 1, to));
  if (b <= a) return -100;
  return 10 * Math.log10((cumulative[b] - cumulative[a]) / (b - a) + 1e-9);
}

// Finds moments where a loudness curve suddenly gets much higher than it was
// just before, and stays there.
function findJumps(series, minJumpDb) {
  const frames = series.length;
  const fps = SLICES_PER_SECOND;
  const cumulative = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) cumulative[i + 1] = cumulative[i] + series[i];

  const before = Math.round(2.5 * fps), gap = Math.round(0.15 * fps), after = Math.round(1.0 * fps);
  const jump = new Float32Array(frames).fill(-100);
  for (let t = before; t < frames - after; t++) {
    jump[t] = levelDb(cumulative, t + Math.round(0.1 * fps), t + after) - levelDb(cumulative, t - before, t - gap);
  }

  // it must lead to a really loud part of the song, not just a bit louder than silence
  const levels = [];
  for (let t = 0; t < frames; t += Math.round(fps)) levels.push(levelDb(cumulative, t, t + Math.round(fps)));
  levels.sort((x, y) => x - y);
  const loudReference = levels[Math.floor(levels.length * 0.9)] || 0;

  const found = [];
  const lookAround = Math.round(1.0 * fps);
  const short = Math.round(0.1 * fps);
  for (let t = Math.round(3 * fps); t < frames - Math.round(2 * fps); t++) {
    if (jump[t] < minJumpDb) continue;
    let isPeak = true;
    for (let j = Math.max(0, t - lookAround); j <= Math.min(frames - 1, t + lookAround); j++) if (jump[j] > jump[t]) { isPeak = false; break; }
    if (!isPeak) continue;
    if (levelDb(cumulative, t, t + after) < loudReference - 15) continue;

    // pin down the exact moment: where does it get louder fastest around here?
    let bestT = t, bestRise = -100;
    for (let j = Math.max(short, t - Math.round(0.6 * fps)); j <= Math.min(frames - short - 1, t + Math.round(0.6 * fps)); j++) {
      const rise = levelDb(cumulative, j, j + short) - levelDb(cumulative, j - short, j);
      if (rise > bestRise) { bestRise = rise; bestT = j; }
    }
    found.push({ seconds: frameToSeconds(bestT), jump: jump[t] });
  }
  return found;
}

// A "drop" is the beat coming in after a part without one: a quiet part, a
// breakdown or a build-up. We look for the kick drum (low hits) starting up
// after a few seconds with almost none, and for really huge jumps in volume.
function findDrops(energy, kickHits, beats) {
  const candidates = [];

  const kicks = kickHits.map((h) => h.seconds);
  const countBetween = (from, to) => kicks.filter((k) => k >= from && k < to).length;
  for (const k of kicks) {
    if (k < 3) continue; // a song that simply starts with its beat has no drop
    if (countBetween(k - 4, k - 0.05) <= 1 && countBetween(k, k + 2.5) >= 4) candidates.push({ seconds: k, score: 100 });
  }
  for (const jump of findJumps(energy, DROP_HUGE_JUMP_DB)) candidates.push({ seconds: jump.seconds, score: jump.jump });

  const drops = [];
  for (const c of candidates.sort((x, y) => y.score - x.score)) {
    let seconds = c.seconds;
    if (beats && beats.confident) { // line it up with the nearest beat if one is close
      const near = beats.times.reduce((best, bt) => (Math.abs(bt - seconds) < Math.abs(best - seconds) ? bt : best), beats.times[0]);
      if (Math.abs(near - seconds) < 0.2) seconds = near;
    }
    if (drops.every((d) => Math.abs(d - seconds) >= DROP_MIN_GAP)) drops.push(seconds);
  }
  return drops.sort((x, y) => x - y);
}

// How loud is the song around each moment, compared with its loud parts?
// Used to make the lights dimmer in quiet parts and fade-outs.
function buildLoudness(energy) {
  const frames = energy.length;
  const fps = SLICES_PER_SECOND;
  const cumulative = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) cumulative[i + 1] = cumulative[i] + energy[i];
  const half = Math.round(0.5 * fps);
  const db = new Float32Array(frames);
  for (let t = 0; t < frames; t++) db[t] = levelDb(cumulative, t - half, t + half);
  const sorted = Float32Array.from(db).sort();
  return { db, reference: sorted[Math.floor(frames * 0.9)] || 0 };
}

// ---------- the whole analysis ----------

// "samples" is the song as mono numbers at ANALYSIS_RATE.
async function analyzeRhythm(samples, density = 'balanced') {
  const factor = DENSITY_FACTOR[density] || 1;
  const { spec, frames, energy } = await computeSpectrogram(samples);
  await keepPercussive(spec, frames);
  await waitForBrowser();

  const flux = {
    bass: bandFlux(spec, frames, 'bass'),
    mid: bandFlux(spec, frames, 'mid'),
    treble: bandFlux(spec, frames, 'treble'),
  };
  const beats = findBeats(flux);

  const hits = {};
  for (const band of ['bass', 'mid', 'treble']) {
    hits[band] = pickHits(flux[band], band, factor);
    if (beats.confident) {
      // second look, now that we know the repeating pattern
      hits[band] = pickHits(flux[band], band, factor, repeatMultipliers(hits[band], beats, frames));
    }
  }

  return {
    bass: hits.bass,
    mid: hits.mid,
    treble: hits.treble,
    beats,
    drops: findDrops(energy, pickHits(bandFlux(spec, frames, 'kick'), 'kick', factor), beats),
    loudness: buildLoudness(energy),
  };
}

// Makes a mono, smaller copy of the song for the analysis (browser only).
async function downmixForAnalysis(buffer) {
  const length = Math.ceil(buffer.duration * ANALYSIS_RATE);
  const offlineCtx = new OfflineAudioContext(1, length, ANALYSIS_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

// ---------- sending everything to the zones ----------

function getZonesForBand(bandName, camera) {
  if (bandName === 'bass') return [0, 2, 4];
  if (bandName === 'mid') return [1, 2, 3];
  if (bandName === 'treble') return camera ? [0, 4, 5, 6] : [0, 4, 5];
}

const BAND_BRIGHTNESS = {
  bass: 3200,
  mid: 4095,
  treble: 4095,
};

const BAND_HIT_LENGTH_FRAMES = {
  bass: 7,
  mid: 4,
  treble: 3,
};

// One sweep: every zone lights up in turn from the top, then fades behind the wave.
function makeSweep(startSeconds, camera) {
  const hits = [];
  const zoneCount = camera ? 7 : 6;
  for (let zone = 0; zone < zoneCount; zone++) {
    const zoneStart = startSeconds + zone * SWEEP_DELAY;
    SWEEP_GLOW.forEach((share, step) => {
      const start = zoneStart + step * SWEEP_GLOW_FRAMES * FRAME_SECONDS;
      hits.push({ zone, start, end: start + SWEEP_GLOW_FRAMES * FRAME_SECONDS, brightness: Math.round(4095 * share) });
    });
  }
  return hits;
}

const SWEEP_LENGTH = 7 * SWEEP_DELAY + SWEEP_GLOW.length * SWEEP_GLOW_FRAMES * (1 / 60);

// Turns the analysis into the light hits for every zone (a list of 7 lists).
function buildLightShow(analysis, { sweeps = true, camera = false } = {}) {
  const lights = [[], [], [], [], [], [], []];
  const { beats, loudness } = analysis;
  const sweepTimes = sweeps ? analysis.drops : [];

  ['bass', 'mid', 'treble'].forEach((bandName) => {
    const zones = getZonesForBand(bandName, camera);
    const maxBrightness = BAND_BRIGHTNESS[bandName];
    const lengthSeconds = BAND_HIT_LENGTH_FRAMES[bandName] * FRAME_SECONDS;
    let counter = 0;

    analysis[bandName].forEach((hit) => {
      if (sweepTimes.some((t) => hit.seconds >= t && hit.seconds < t + SWEEP_LENGTH)) return; // the sweep owns this moment

      // strength 1 = just above the bar, 2.2 or more = a clear, strong hit
      const power = Math.min(1, Math.max(0, (hit.strength - 1) / 1.2));
      let share = MIN_BRIGHTNESS_SHARE + (1 - MIN_BRIGHTNESS_SHARE) * power;

      // quiet parts and fade-outs: dimmer lights
      const frame = Math.min(loudness.db.length - 1, Math.max(0, Math.round(hit.seconds * SLICES_PER_SECOND)));
      share *= Math.min(1, Math.max(0.4, 1 + (loudness.db[frame] - loudness.reference) / 24));

      // Where does this hit go? With a steady beat: by its place in the bar, so a
      // repeating pattern always lights the same zones. Otherwise: take turns.
      const index = beats.confident ? Math.floor(slotInBar(hit.seconds, beats) / 2) : counter++;
      const zone = zones[index % zones.length];
      lights[zone].push({ start: hit.seconds, end: hit.seconds + lengthSeconds, brightness: Math.round(maxBrightness * share) });
    });
  });

  sweepTimes.forEach((t) => {
    makeSweep(t, camera).forEach((h) => lights[h.zone].push({ start: h.start, end: h.end, brightness: h.brightness }));
  });
  return lights;
}

async function autoGenerateLightShow(density = 'balanced', sweeps = true) {
  const samples = await downmixForAnalysis(audioBuffer);
  const analysis = await analyzeRhythm(samples, density);

  zoneHits = buildLightShow(analysis, { sweeps, camera: includeCameraZone });
  renderAllHits();
}