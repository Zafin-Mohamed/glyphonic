// glyphFormat.js
// Automatically creates a light show from the song.
//
// Idea: people feel a song's beat in its drums, not in its singing or its
// sustained notes. So we
//   1. turn the song into a picture of its sound over time (a spectrogram),
//   2. keep only the sharp, drum-like parts and throw away the held, melodic
//      parts (vocals, pads, held guitar notes),
//   3. find the moments where those drum-like sounds suddenly get stronger
//      in the low, middle and high ranges, and
//   4. send those moments to different zones of the Glyph Bar.

// ---------- settings ----------

const ANALYSIS_RATE = 22050;  // we analyse a smaller copy of the song, it's faster
const FFT_SIZE = 1024;        // length of each "slice" of sound we look at (about 46 ms)
const HOP_SIZE = 256;         // how far we move between slices (about 11.6 ms)
const MAX_BIN = 480;          // ignore anything above about 10 kHz
const ONSET_OFFSET = 0.0;     // seconds to move every detected hit earlier (timing fine-tune)
const HELD_NOTE_HALF = 15;    // how far (in slices) we look sideways to spot held notes
const DRUM_HIT_HALF = 8;      // how far (in frequency bins) we look up and down to spot drum hits

// How many frequency "bins" belong to each range (one bin is about 21.5 Hz).
const BAND_BINS = {
  bass: [1, 8],       // roughly 20 - 170 Hz     (kick drum, bass)
  mid: [9, 140],      // roughly 190 - 3000 Hz   (snare, claps)
  treble: [232, 465], // roughly 5000 - 10000 Hz (hi-hats, cymbals)
};

// How picky each range is. A higher "sensitivity" number means fewer hits.
const BAND_SETTINGS = {
  bass:   { sensitivity: 2.0, peakRadius: 4, minGap: 0.18 },
  mid:    { sensitivity: 2.4, peakRadius: 3, minGap: 0.12 },
  treble: { sensitivity: 2.6, peakRadius: 2, minGap: 0.08 },
};

// "Calm" gives fewer lights, "Busy" gives more.
const DENSITY_FACTOR = { calm: 1.25, balanced: 1.0, busy: 0.7 };

// Weaker hits are a bit dimmer, clear beats are full brightness. This is the
// share of full brightness the weakest hits get. Set it to 1 to make every
// hit equally bright.
const MIN_BRIGHTNESS_SHARE = 0.5;

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
// Result: a flat list, frames x MAX_BIN, row by row.
async function computeSpectrogram(samples) {
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP_SIZE) + 1);
  const spec = new Float32Array(frames * MAX_BIN);
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
    for (let k = 0; k < MAX_BIN; k++) spec[row + k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    if (t % 1500 === 1499) await waitForBrowser(); // keep the page responsive
  }
  return { spec, frames };
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

// Picks the moments where the flux jumps up clearly higher than it normally is nearby.
function pickHits(flux, bandName, densityFactor) {
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
    const threshold = Math.max(mean + sensitivity * densityFactor * std, loudFloor);
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
    const seconds = ((t + shift) * HOP_SIZE + FFT_SIZE / 2) / ANALYSIS_RATE - ONSET_OFFSET;

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

// The whole analysis. "samples" is the song as mono numbers at ANALYSIS_RATE.
// Returns the hits found in each range, each with its time (seconds) and strength.
async function analyzeRhythm(samples, density = 'balanced') {
  const factor = DENSITY_FACTOR[density] || 1;
  const { spec, frames } = await computeSpectrogram(samples);
  await keepPercussive(spec, frames);
  await waitForBrowser();

  return {
    bass: pickHits(bandFlux(spec, frames, 'bass'), 'bass', factor),
    mid: pickHits(bandFlux(spec, frames, 'mid'), 'mid', factor),
    treble: pickHits(bandFlux(spec, frames, 'treble'), 'treble', factor),
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

// ---------- sending the hits to zones ----------

function getZonesForBand(bandName) {
  if (bandName === 'bass') return [0, 2, 4];
  if (bandName === 'mid') return [1, 2, 3];
  if (bandName === 'treble') {
    return includeCameraZone ? [0, 4, 5, 6] : [0, 4, 5];
  }
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

// Every range rotates through its zones one hit at a time, so the lights move.
function applyBandHits(hits, bandName) {
  const zones = getZonesForBand(bandName);
  const maxBrightness = BAND_BRIGHTNESS[bandName];
  const lengthSeconds = BAND_HIT_LENGTH_FRAMES[bandName] * FRAME_SECONDS;

  hits.forEach((hit, i) => {
    // strength 1 = just above the bar, 2.2 or more = a clear, strong hit
    const power = Math.min(1, Math.max(0, (hit.strength - 1) / 1.2));
    const share = MIN_BRIGHTNESS_SHARE + (1 - MIN_BRIGHTNESS_SHARE) * power;
    const brightness = Math.round(maxBrightness * share);

    const zoneIndex = zones[i % zones.length];
    zoneHits[zoneIndex].push({ start: hit.seconds, end: hit.seconds + lengthSeconds, brightness });
  });
}

async function autoGenerateLightShow(density = 'balanced') {
  const samples = await downmixForAnalysis(audioBuffer);
  const { bass, mid, treble } = await analyzeRhythm(samples, density);

  zoneHits = [[], [], [], [], [], [], []];
  applyBandHits(bass, 'bass');
  applyBandHits(mid, 'mid');
  applyBandHits(treble, 'treble');

  renderAllHits();
}