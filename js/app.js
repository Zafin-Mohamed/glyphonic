// app.js
// This file connects the HTML page to our other JS files.

const fileInput = document.getElementById('file-input');
const fileDropLabel = document.getElementById('file-drop-label');
const editorPanel = document.getElementById('editor-panel');
const exportPanel = document.getElementById('export-panel');
const transport = document.getElementById('transport');
const playBtn = document.getElementById('play-btn');
const timeReadout = document.getElementById('time-readout');
const playhead = document.getElementById('playhead');
const autoGenerateBtn = document.getElementById('auto-generate-btn');
const compositionTitle = document.getElementById('composition-title');
const exportBtn = document.getElementById('export-btn');
const exportStatus = document.getElementById('export-status');

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files[0]; // the file the user picked

  if (!file) return; // they clicked but picked nothing — do nothing

  // Starting fresh: stop any playback and clear hits left over from a previous song.
  pauseAudio();
  playStartOffset = 0;
  playBtn.textContent = '▶';
  zoneHits = [[], [], [], [], [], [], []];

  fileDropLabel.textContent = file.name; // show the filename instead of the placeholder text
  editorPanel.hidden = false; // reveal BEFORE loading, so the canvas has real size to measure

  try {
    await loadAudioFile(file); // defined in waveform.js
  } catch (error) {
    console.error(error);
    fileDropLabel.textContent = "Couldn't read that file. Try another MP3, WAV or OGG.";
    editorPanel.hidden = true;
    exportPanel.hidden = true;
    transport.hidden = true;
    return;
  }

  transport.hidden = false;   // now that audio is loaded, show the play button
  exportPanel.hidden = false; // and the export section
  compositionTitle.value = file.name.replace(/\.[^.]+$/, ''); // default title = file name without extension
  setExportStatus('');
  renderZones();              // build the zone lanes now that we know the song's duration
  updateTimeReadout();
});

// Turns seconds into "00:00.00" style text.
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

function updateTimeReadout() {
  const current = getCurrentPlaybackTime();
  const duration = audioBuffer ? audioBuffer.duration : 0;
  timeReadout.textContent = `${formatTime(current)} / ${formatTime(duration)}`;

  const waveformWrap = document.querySelector('.waveform-wrap');
  if (waveformWrap) {
    playhead.style.left = secondsToPixel(current, waveformWrap.clientWidth) + 'px';
  }
}

playBtn.addEventListener('click', () => {
  if (isPlaying) {
    pauseAudio();
    playBtn.textContent = '▶';
  } else {
    playAudio(getCurrentPlaybackTime());
    playBtn.textContent = '⏸';
    requestAnimationFrame(playbackLoop);
  }
});

// Runs repeatedly while playing, to keep the time readout live.
function playbackLoop() {
  if (!isPlaying) return;

  updateTimeReadout();

  if (getCurrentPlaybackTime() >= audioBuffer.duration) {
    pauseAudio();
    playBtn.textContent = '▶';
    playStartOffset = 0;
    updateTimeReadout();
    return;
  }

  requestAnimationFrame(playbackLoop);
}

autoGenerateBtn.addEventListener('click', async () => {
  autoGenerateBtn.textContent = 'Analyzing...';
  autoGenerateBtn.disabled = true;

  await autoGenerateLightShow();

  autoGenerateBtn.textContent = 'Auto-generate light show';
  autoGenerateBtn.disabled = false;
});

// --- Export ---

function setExportStatus(message, kind) {
  exportStatus.textContent = message;
  exportStatus.className = 'status' + (kind ? ' ' + kind : '');
}

// Makes the browser "download" a file we built in memory.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

exportBtn.addEventListener('click', async () => {
  const title = compositionTitle.value.trim() || 'Glyphonic composition';
  exportBtn.disabled = true;

  try {
    const blob = await exportComposition(title, (message) => setExportStatus(message));
    const safeName = title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'glyphonic-composition';
    downloadBlob(blob, safeName + '.ogg');
    setExportStatus(`Done. Saved "${safeName}.ogg" (${(blob.size / 1024 / 1024).toFixed(2)} MB). See "Put it on your phone" below.`, 'ok');
  } catch (error) {
    console.error(error);
    setExportStatus(error.message || 'Export failed.', 'error');
  } finally {
    exportBtn.disabled = false;
  }
});