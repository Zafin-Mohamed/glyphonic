// app.js
// This file connects the HTML page to our other JS files.
// Today it just listens for a file being picked and loads it.

const fileInput = document.getElementById('file-input');
const fileDropLabel = document.getElementById('file-drop-label');
const editorPanel = document.getElementById('editor-panel');
const transport = document.getElementById('transport');
const playBtn = document.getElementById('play-btn');
const timeReadout = document.getElementById('time-readout');  
const playhead = document.getElementById('playhead');

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files[0]; // the file the user picked

  if (!file) return; // they clicked but picked nothing — do nothing

    fileDropLabel.textContent = file.name; // show the filename instead of the placeholder text

  editorPanel.hidden = false; // reveal BEFORE loading, so the canvas has real size to measure

  await loadAudioFile(file); // defined in waveform.js

    transport.hidden = false;   // now that audio is loaded, show the play button
  renderZones();               // build the zone lanes now that we know the song's duration
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