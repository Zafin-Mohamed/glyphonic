// glyphFormat.js
function detectHits(channelData, sampleRate, threshold = 1.4, minGapSeconds = 0.08, peakRadius = 6, historyLength = 20) {
  const windowSize = Math.floor(sampleRate * 0.02);
  const energies = [];

  for (let i = 0; i < channelData.length; i += windowSize) {
    let sum = 0;
    const end = Math.min(i + windowSize, channelData.length);
    for (let j = i; j < end; j++) {
      sum += channelData[j] * channelData[j];
    }
    energies.push(sum / (end - i));
  }

  const candidates = [];
  for (let i = historyLength; i < energies.length; i++) {
    const recent = energies.slice(i - historyLength, i);
    const localAverage = recent.reduce((a, b) => a + b, 0) / recent.length;

    if (energies[i] > localAverage * threshold && energies[i] > 0.0001) {
      candidates.push(i);
    }
  }

  const peaks = candidates.filter((i) => {
    const start = Math.max(0, i - peakRadius);
    const end = Math.min(energies.length, i + peakRadius);
    for (let j = start; j < end; j++) {
      if (energies[j] > energies[i]) return false;
    }
    return true;
  });

  const merged = [];
  for (const i of peaks) {
    const timeSeconds = (i * windowSize) / sampleRate;
    if (merged.length === 0 || timeSeconds - merged[merged.length - 1] > minGapSeconds) {
      merged.push(timeSeconds);
    }
  }

  return merged;
}

async function splitIntoBands(buffer) {
  const sampleRate = buffer.sampleRate;

  async function renderFiltered(type, frequency) {
    const offlineCtx = new OfflineAudioContext(1, buffer.length, sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;

    const filter = offlineCtx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;

    source.connect(filter);
    filter.connect(offlineCtx.destination);
    source.start(0);

    const renderedBuffer = await offlineCtx.startRendering();
    return renderedBuffer.getChannelData(0);
  }

  const bass = await renderFiltered('lowpass', 150);
  const mid = await renderFiltered('bandpass', 1500);
  const treble = await renderFiltered('highpass', 5000);

  return { bass, mid, treble, sampleRate };
}

function getZonesForBand(bandName) {
  if (bandName === 'bass') return [0, 2, 4];
  if (bandName === 'mid') return [1, 2, 3];
  if (bandName === 'treble') {
    return includeCameraZone ? [0, 4, 5, 6] : [0, 4, 5];
  }
}

const BAND_BRIGHTNESS = {
  bass: 3200, // a bit brighter now that it's not stacking 3 zones at once per hit
  mid: 4095,
  treble: 4095,
};

const BAND_HIT_LENGTH_FRAMES = {
  bass: 7,
  mid: 4,
  treble: 3,
};

// All bands now rotate through their zones one hit at a time —
// no band broadcasts to all its zones simultaneously anymore.
function applyBandHits(hitTimes, bandName) {
  const zones = getZonesForBand(bandName);
  const brightness = BAND_BRIGHTNESS[bandName];
  const lengthSeconds = BAND_HIT_LENGTH_FRAMES[bandName] * FRAME_SECONDS;

  hitTimes.forEach((startSeconds, i) => {
    const zoneIndex = zones[i % zones.length];
    zoneHits[zoneIndex].push({ start: startSeconds, end: startSeconds + lengthSeconds, brightness });
  });
}

async function autoGenerateLightShow() {
  const { bass, mid, treble, sampleRate } = await splitIntoBands(audioBuffer);

  const bassHits = detectHits(bass, sampleRate, 3.0, 0.4, 15, 40);
  const midHits = detectHits(mid, sampleRate, 1.5, 0.15, 7, 20);
  const trebleHits = detectHits(treble, sampleRate, 1.4, 0.1, 5, 20);

  zoneHits = [[], [], [], [], [], [], []];
  applyBandHits(bassHits, 'bass');
  applyBandHits(midHits, 'mid');
  applyBandHits(trebleHits, 'treble');

  renderAllHits();
}