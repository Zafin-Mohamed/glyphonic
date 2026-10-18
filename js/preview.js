// preview.js
// A small picture of the Nothing Phone (4a) Glyph Bar that lights up while the
// song plays, using the same light data that gets exported. It lets you judge
// a light show before moving a file to your phone.
//
// The Glyph Bar has 6 white zones (top to bottom: Z1 to Z6) and, below them,
// the red camera light (CAM).

const GLYPH_NAMES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'CAM'];
const glyphBar = document.getElementById('glyph-bar');
const glyphLabels = document.getElementById('glyph-labels');
const glyphSegments = [];

// Build the 7 segments and their labels once, when the page loads.
GLYPH_NAMES.forEach((name, zone) => {
  const segment = document.createElement('div');
  segment.className = 'glyph-seg';
  segment.style.setProperty('--seg-color', zone === 6 ? '#ff2a2a' : '#ffffff');
  glyphBar.appendChild(segment);
  glyphSegments.push(segment);

  const label = document.createElement('span');
  label.textContent = name;
  glyphLabels.appendChild(label);
});

// How bright (0 to 1) is a zone during a given frame? This uses exactly the
// same rule as the export, so what you see here is what the phone gets.
function getZoneLevel(hits, frame) {
  let level = 0;
  for (const hit of hits) {
    const startFrame = Math.max(0, Math.floor(hit.start * FRAMES_PER_SECOND));
    let endFrame = Math.ceil(hit.end * FRAMES_PER_SECOND);
    if (endFrame <= startFrame) endFrame = startFrame + 1;
    if (frame >= startFrame && frame < endFrame) {
      level = Math.max(level, hit.brightness / 4095);
    }
  }
  return level;
}

// Lights the preview for the given moment in the song. Only lights up while
// the song is playing, like the real phone.
function updateGlyphPreview(timeSeconds) {
  const frame = Math.floor(timeSeconds * FRAMES_PER_SECOND);

  for (let zone = 0; zone < GLYPH_NAMES.length; zone++) {
    const segment = glyphSegments[zone];
    const enabled = zone < 6 || includeCameraZone; // CAM only counts if the box is ticked
    segment.classList.toggle('is-disabled', !enabled);

    const level = (isPlaying && enabled) ? getZoneLevel(zoneHits[zone], frame) : 0;
    segment.style.setProperty('--level', level.toFixed(3));
  }
}

// When the camera-light checkbox changes, update the preview straight away.
document.getElementById('camera-zone-toggle').addEventListener('change', () => {
  updateGlyphPreview(getCurrentPlaybackTime());
});