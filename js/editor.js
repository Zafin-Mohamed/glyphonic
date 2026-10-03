// editor.js
// Turns the 6 (or 7) Glyph zones into clickable lanes where the user
// places "light hits" — moments when a zone should light up.

const ZONE_LABELS = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'CAM'];
const STANDARD_ZONE_COUNT = 6;
const FRAME_SECONDS = 1 / 60; // the Glyph format works in 60Hz frames (16.666ms each)

// zoneHits[i] is an array of hits for zone i. Index 6 is the unofficial
// red camera-indicator zone, only used if the user opts in.
let zoneHits = [[], [], [], [], [], [], []];
let includeCameraZone = false;

const zonesContainer = document.getElementById('zones');
const hitLengthInput = document.getElementById('hit-length');
const hitLengthOut = document.getElementById('hit-length-out');
const hitBrightnessInput = document.getElementById('hit-brightness');
const hitBrightnessOut = document.getElementById('hit-brightness-out');
const clearBtn = document.getElementById('clear-btn');
const cameraToggle = document.getElementById('camera-zone-toggle');

// Converts a click's x position inside a lane into a time in seconds,
// based on how wide the lane is and how long the whole song is.
function pixelToSeconds(x, laneWidth) {
  const duration = audioBuffer.duration; // audioBuffer comes from waveform.js
  return (x / laneWidth) * duration;
}

function secondsToPixel(seconds, laneWidth) {
  const duration = audioBuffer.duration;
  return (seconds / duration) * laneWidth;
}

// Builds the zone lanes from scratch. Called once audio loads, and
// again whenever the camera zone toggle changes.
function renderZones() {
  zonesContainer.innerHTML = '';
  const zoneCount = includeCameraZone ? 7 : STANDARD_ZONE_COUNT;

  for (let i = 0; i < zoneCount; i++) {
    const lane = document.createElement('div');
    lane.className = 'zone-lane';
    lane.dataset.zone = i;

    const label = document.createElement('span');
    label.className = 'zone-label';
    label.textContent = ZONE_LABELS[i];
    lane.appendChild(label);

    lane.addEventListener('click', (e) => {
      // If the click landed on an existing hit (or its resize handle),
      // that element's own listener handles it — don't also place a new one.
      if (e.target.closest('.zone-hit')) return;

      const rect = lane.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const startSeconds = pixelToSeconds(x, rect.width);
      placeHit(i, startSeconds);
    });

    zonesContainer.appendChild(lane);
  }

  renderAllHits();
}

// Adds a new hit to a zone at the given start time, using whatever
// the length/brightness sliders are currently set to.
function placeHit(zoneIndex, startSeconds) {
  const frames = parseInt(hitLengthInput.value, 10);
  const lengthSeconds = frames * FRAME_SECONDS;
  const brightness = parseInt(hitBrightnessInput.value, 10);

  zoneHits[zoneIndex].push({
    start: startSeconds,
    end: startSeconds + lengthSeconds,
    brightness,
  });

  renderAllHits();
}

// Redraws every hit block in every visible lane, based on zoneHits.
// We just clear and rebuild rather than tracking individual DOM nodes —
// simpler to reason about, and there are never enough hits for this to be slow.
function renderAllHits() {
  const lanes = zonesContainer.querySelectorAll('.zone-lane');

  lanes.forEach((lane) => {
    lane.querySelectorAll('.zone-hit').forEach((el) => el.remove());

    const zoneIndex = parseInt(lane.dataset.zone, 10);
    const laneWidth = lane.clientWidth;

    zoneHits[zoneIndex].forEach((hit, hitIndex) => {
      const hitEl = document.createElement('div');
      hitEl.className = 'zone-hit';
      hitEl.style.left = secondsToPixel(hit.start, laneWidth) + 'px';
      hitEl.style.width = Math.max(2, secondsToPixel(hit.end - hit.start, laneWidth)) + 'px';
      hitEl.style.opacity = hit.brightness / 4095;

      // Click a hit to remove it.
      hitEl.addEventListener('click', (e) => {
        e.stopPropagation(); // don't let this bubble up and place a new hit too
        zoneHits[zoneIndex].splice(hitIndex, 1);
        renderAllHits();
      });

      // Drag the right edge to resize.
      const handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        startResize(zoneIndex, hitIndex, lane);
      });
      hitEl.appendChild(handle);

      lane.appendChild(hitEl);
    });
  });
}

// Handles dragging a hit's resize handle to change its length.
function startResize(zoneIndex, hitIndex, lane) {
  function onMouseMove(e) {
    const rect = lane.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const newEnd = pixelToSeconds(x, rect.width);
    const hit = zoneHits[zoneIndex][hitIndex];

    hit.end = Math.max(hit.start + FRAME_SECONDS, newEnd); // keep a minimum length
    renderAllHits();
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

// --- Slider wiring ---

hitLengthInput.addEventListener('input', () => {
  const ms = Math.round(parseInt(hitLengthInput.value, 10) * FRAME_SECONDS * 1000);
  hitLengthOut.textContent = `${ms} ms`;
});

hitBrightnessInput.addEventListener('input', () => {
  hitBrightnessOut.textContent = hitBrightnessInput.value;
});

clearBtn.addEventListener('click', () => {
  zoneHits = [[], [], [], [], [], [], []];
  renderAllHits();
});

cameraToggle.addEventListener('change', () => {
  includeCameraZone = cameraToggle.checked;
  renderZones();
});