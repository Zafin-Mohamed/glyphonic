// glyphExport.js
// Turns the light hits you see in the editor into the exact data format the
// Nothing Phone (4a) reads, and builds the final .ogg file.
//
// Format reference: https://github.com/SebiAi/custom-nothing-glyph-tools
// (docs/9_Technical Details.md)

const FRAMES_PER_SECOND = 60; // the phone reads one line of light data every 1/60th of a second

// Builds the light data: one line per frame, one number (0-4095 brightness)
// per zone, each number followed by a comma, lines ending in \r\n.
function buildAuthorCsv(hitsByZone, columns, durationSeconds) {
  // +1 spare line so rounding can never leave the end of the song without data
  const frames = Math.ceil(durationSeconds * FRAMES_PER_SECOND - 1e-6) + 1;
  const grid = new Uint16Array(frames * columns); // starts as all zeros = all lights off

  for (let zone = 0; zone < columns; zone++) {
    for (const hit of hitsByZone[zone]) {
      const startFrame = Math.max(0, Math.floor(hit.start * FRAMES_PER_SECOND));
      let endFrame = Math.ceil(hit.end * FRAMES_PER_SECOND);
      if (endFrame <= startFrame) endFrame = startFrame + 1; // every hit lasts at least one frame
      endFrame = Math.min(endFrame, frames);
      const brightness = Math.max(0, Math.min(4095, Math.round(hit.brightness)));

      for (let f = startFrame; f < endFrame; f++) {
        const index = f * columns + zone;
        if (brightness > grid[index]) grid[index] = brightness; // overlapping hits: brightest wins
      }
    }
  }

  const lines = [];
  for (let f = 0; f < frames; f++) {
    let line = '';
    for (let z = 0; z < columns; z++) line += grid[f * columns + z] + ',';
    lines.push(line);
  }
  return lines.join('\r\n') + '\r\n';
}

// Builds the small "dots" list the official Composer app would show on its
// timeline. Format: "milliseconds-buttonId," repeated. Button ids are 0 to 4.
function buildCustom1(hitsByZone, columns) {
  const dots = [];
  for (let zone = 0; zone < columns; zone++) {
    for (const hit of hitsByZone[zone]) {
      dots.push({ ms: Math.round(hit.start * 1000), id: Math.min(zone, 4) });
    }
  }
  dots.sort((a, b) => a.ms - b.ms);
  return dots.slice(0, 2000).map((d) => `${d.ms}-${d.id},`).join('');
}

// The phone wants tag data compressed (zlib, best compression), then turned
// into text (base64, without the trailing "=" padding), split into lines of 76
// characters. This does all of that.
function packTagData(text) {
  const compressed = pako.deflate(textToBytes(text), { level: 9 });

  let binary = '';
  for (let i = 0; i < compressed.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, compressed.subarray(i, i + 0x8000));
  }
  const base64 = btoa(binary).replace(/=+$/, '');

  const lines = [];
  for (let i = 0; i < base64.length; i += 76) lines.push(base64.slice(i, i + 76));
  return lines.join('\n') + '\n';
}

// The whole pipeline: returns a Blob (the finished .ogg file).
async function exportComposition(title, onProgress) {
  const columns = includeCameraZone ? 7 : 6; // from editor.js
  const hasHits = zoneHits.slice(0, columns).some((zone) => zone.length > 0);
  if (!hasHits) {
    throw new Error('There are no light hits yet. Click "Auto-generate light show" or place some hits first.');
  }

  onProgress('Preparing audio…');
  const audio48k = await resampleTo48kStereo(audioBuffer);
  const totalSamples = audio48k.length;
  const durationSeconds = totalSamples / OPUS_RATE;

  onProgress('Building light data…');
  const authorCsv = buildAuthorCsv(zoneHits, columns, durationSeconds);
  const custom1 = buildCustom1(zoneHits, columns);

  const { packets, opusHead } = await encodeToOpusPackets(audio48k, onProgress);

  onProgress('Writing file…');
  const head = opusHead || buildOpusHead(2, DEFAULT_PRE_SKIP, OPUS_RATE);
  const preSkip = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true);

  const tags = [
    ['TITLE', title],
    ['ALBUM', 'Glyphonic'],
    ['AUTHOR', packTagData(authorCsv)],
    ['COMPOSER', 'v1-Frogger Glyph Composer'],   // "Frogger" is the Phone (4a)'s internal name
    ['CUSTOM1', packTagData(custom1)],
    ['CUSTOM2', columns === 7 ? '7cols' : '6cols'],
  ];

  const file = muxOggOpus({
    opusHead: head,
    tags,
    vendor: 'Glyphonic',
    packets,
    preSkip,
    totalSamples,
  });

  return new Blob([file], { type: 'audio/ogg' });
}