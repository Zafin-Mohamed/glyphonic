// waveform.js
// This file is responsible for: reading the audio file the user picks,
// turning it into something we can draw, and drawing it on the canvas.

let audioBuffer = null;   // will hold the decoded audio once a file is loaded
let audioContext = null;  // the browser's built-in audio engine
let sourceNode = null;
let isPlaying = false;
let playStartTime = 0;      // when playback started, in AudioContext time
let playStartOffset = 0;    // where in the song we started playing from

// Takes the raw file the user selected and decodes it into audio data
// we can actually work with.
async function loadAudioFile(file) {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  const arrayBuffer = await file.arrayBuffer(); // read the file as raw bytes
  audioBuffer = await audioContext.decodeAudioData(arrayBuffer); // turn bytes into audio data

  drawWaveform(audioBuffer);
  return audioBuffer;
}

// Draws a waveform picture of the audio onto the <canvas id="waveform">.
function drawWaveform(buffer) {
  const canvas = document.getElementById('waveform');
  const ctx = canvas.getContext('2d');

  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;

  const data = buffer.getChannelData(0); // the raw sound wave numbers, first audio channel
  const width = canvas.width;
  const height = canvas.height;
  const middle = height / 2;

  const samplesPerPixel = Math.floor(data.length / width);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#d6001c';

  for (let x = 0; x < width; x++) {
    let min = 1.0;
    let max = -1.0;
    const start = x * samplesPerPixel;
    for (let i = 0; i < samplesPerPixel; i++) {
      const sample = data[start + i];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    const y1 = middle + min * middle;
    const y2 = middle + max * middle;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

// Starts playback from a given position (in seconds).
function playAudio(fromSeconds = 0) {
  if (!audioBuffer) return;
  if (sourceNode) sourceNode.stop(); // stop anything already playing

  sourceNode = audioContext.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(audioContext.destination); // "destination" = your speakers
  sourceNode.start(0, fromSeconds);

  playStartTime = audioContext.currentTime;
  playStartOffset = fromSeconds;
  isPlaying = true;
}

function pauseAudio() {
  if (sourceNode) sourceNode.stop();
  isPlaying = false;
}

// How far into the song we currently are, in seconds.
function getCurrentPlaybackTime() {
  if (!isPlaying) return playStartOffset;
  return playStartOffset + (audioContext.currentTime - playStartTime);
}