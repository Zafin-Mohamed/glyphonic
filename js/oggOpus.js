// oggOpus.js
// Nothing's phones only accept Glyph ringtones that are Opus audio inside an
// .ogg file, with the light data stored in the file's tags. This file:
//   1. encodes any audio into Opus (using the browser's built-in encoder)
//   2. wraps it in a proper .ogg container together with our tags

const OPUS_RATE = 48000;
const DEFAULT_PRE_SKIP = 312; // standard Opus encoder delay, in samples

// ---------- small helpers ----------

function textToBytes(text) {
  return new TextEncoder().encode(text);
}

function isValidOpusHead(bytes) {
  if (!bytes || bytes.length < 19) return false;
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  return magic === 'OpusHead' && bytes[9] === 2;
}

// ---------- the two header packets every Ogg Opus file starts with ----------

function buildOpusHead(channels, preSkip, inputRate) {
  const bytes = new Uint8Array(19);
  const view = new DataView(bytes.buffer);
  bytes.set(textToBytes('OpusHead'), 0);
  bytes[8] = 1;                          // version
  bytes[9] = channels;
  view.setUint16(10, preSkip, true);     // samples the decoder must skip at the start
  view.setUint32(12, inputRate, true);
  view.setInt16(16, 0, true);            // output gain
  bytes[18] = 0;                         // channel mapping family
  return bytes;
}

// "tags" is a list of [name, value] pairs, e.g. [['TITLE', 'My song'], ...]
function buildOpusTags(vendor, tags) {
  const vendorBytes = textToBytes(vendor);
  const comments = tags.map(([name, value]) => textToBytes(`${name}=${value}`));

  let size = 8 + 4 + vendorBytes.length + 4;
  comments.forEach((c) => { size += 4 + c.length; });

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(textToBytes('OpusTags'), offset); offset += 8;
  view.setUint32(offset, vendorBytes.length, true); offset += 4;
  out.set(vendorBytes, offset); offset += vendorBytes.length;
  view.setUint32(offset, comments.length, true); offset += 4;
  for (const c of comments) {
    view.setUint32(offset, c.length, true); offset += 4;
    out.set(c, offset); offset += c.length;
  }
  return out;
}

// ---------- writing Ogg pages ----------
// An .ogg file is a list of "pages". Each page has a 27-byte header, a table
// saying how long each chunk is (the "lacing" table, max 255 entries, each
// entry max 255 bytes), then the data itself.

class OggPageWriter {
  constructor(serial) {
    this.serial = serial;
    this.sequence = 0;
    this.pages = [];
    this.wroteFirstPage = false;
    this.nextPageContinues = false;
    this._startNewPage();
  }

  _startNewPage() {
    this.lacing = [];
    this.chunks = [];
    this.payloadSize = 0;
    this.granule = -1n; // -1 means "no packet finishes on this page"
  }

  _flush(isLast) {
    if (this.lacing.length === 0) return;

    let headerType = 0;
    if (this.nextPageContinues) headerType |= 0x01; // continues a packet from the previous page
    if (!this.wroteFirstPage) headerType |= 0x02;   // first page of the file
    if (isLast) headerType |= 0x04;                 // last page of the file

    const headerSize = 27 + this.lacing.length;
    const page = new Uint8Array(headerSize + this.payloadSize);
    const view = new DataView(page.buffer);

    page.set([0x4f, 0x67, 0x67, 0x53], 0);          // the letters "OggS"
    page[4] = 0;                                    // format version
    page[5] = headerType;
    view.setBigInt64(6, this.granule, true);        // position in the audio
    view.setUint32(14, this.serial, true);
    view.setUint32(18, this.sequence, true);
    view.setUint32(22, 0, true);                    // checksum placeholder
    page[26] = this.lacing.length;
    page.set(this.lacing, 27);

    let offset = headerSize;
    for (const chunk of this.chunks) {
      page.set(chunk, offset);
      offset += chunk.length;
    }

    view.setUint32(22, oggCrc32(page), true);       // real checksum, computed last
    this.pages.push(page);

    this.sequence++;
    this.wroteFirstPage = true;
    this.nextPageContinues = this.lacing[this.lacing.length - 1] === 255;
    this._startNewPage();
  }

  // Adds one complete packet. "endGranule" is the audio position to stamp on
  // the page where this packet finishes.
  addPacket(data, endGranule, { flushAfter = false, pageTarget = 8192 } = {}) {
    if (this.payloadSize >= pageTarget) this._flush(false);

    const fullSegments = Math.floor(data.length / 255);
    const lastSegment = data.length % 255;
    let offset = 0;

    for (let i = 0; i <= fullSegments; i++) {
      if (this.lacing.length === 255) this._flush(false);
      const length = i < fullSegments ? 255 : lastSegment;
      this.lacing.push(length);
      if (length > 0) {
        this.chunks.push(data.subarray(offset, offset + length));
        this.payloadSize += length;
        offset += length;
      }
    }

    this.granule = BigInt(endGranule);
    if (flushAfter) this._flush(false);
  }

  finish() {
    this._flush(true);
    let total = 0;
    this.pages.forEach((p) => { total += p.length; });
    const file = new Uint8Array(total);
    let offset = 0;
    this.pages.forEach((p) => { file.set(p, offset); offset += p.length; });
    return file;
  }
}

// Builds the finished .ogg file.
//   opusHead:     the OpusHead packet (bytes)
//   tags:         list of [name, value] pairs
//   packets:      list of { data: Uint8Array, samples: number } (the encoded audio)
//   preSkip:      encoder delay from the OpusHead
//   totalSamples: how many real audio samples (at 48000 Hz) the song has
function muxOggOpus({ opusHead, tags, vendor, packets, preSkip, totalSamples, serial }) {
  const writer = new OggPageWriter(serial !== undefined ? serial : (Math.random() * 0xffffffff) >>> 0);

  writer.addPacket(opusHead, 0, { flushAfter: true });
  writer.addPacket(buildOpusTags(vendor, tags), 0, { flushAfter: true });

  // "position" counts every sample the decoder produces from the start
  // (including the encoder-delay samples it throws away at the beginning).
  let position = 0;
  packets.forEach((packet, i) => {
    position += packet.samples;
    const isLast = i === packets.length - 1;
    // On the very last packet, cut off the encoder's padding so the song ends exactly on time.
    const granule = isLast ? Math.min(position, preSkip + totalSamples) : position;
    writer.addPacket(packet.data, granule);
  });

  return writer.finish();
}

// ---------- browser-only part: turning audio into Opus packets ----------

// Converts any decoded audio into 48000 Hz stereo (what Opus wants).
async function resampleTo48kStereo(buffer) {
  const length = Math.ceil(buffer.duration * OPUS_RATE);
  const offlineCtx = new OfflineAudioContext(2, length, OPUS_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  return await offlineCtx.startRendering();
}

async function encodeToOpusPackets(buffer48k, onProgress) {
  if (typeof AudioEncoder === 'undefined') {
    throw new Error("This browser can't encode Opus audio. Please use a recent version of Chrome or Edge.");
  }

  const config = { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 2, bitrate: 128000 };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error("This browser doesn't support Opus encoding. Please use a recent version of Chrome or Edge.");
  }

  const packets = [];
  let opusHead = null;
  let encoderError = null;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const samples = chunk.duration ? Math.round((chunk.duration * OPUS_RATE) / 1e6) : 960;
      packets.push({ data, samples });

      // Some browsers hand us a ready-made OpusHead header; use it if so.
      const description = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
      if (!opusHead && description) {
        const bytes = description instanceof ArrayBuffer
          ? new Uint8Array(description)
          : new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
        if (isValidOpusHead(bytes)) opusHead = bytes.slice();
      }
    },
    error: (e) => { encoderError = e; },
  });

  encoder.configure(config);

  const left = buffer48k.getChannelData(0);
  const right = buffer48k.numberOfChannels > 1 ? buffer48k.getChannelData(1) : left;
  const total = buffer48k.length;
  const CHUNK = 9600; // 200 ms of audio at a time

  for (let start = 0; start < total; start += CHUNK) {
    if (encoderError) break;
    const n = Math.min(CHUNK, total - start);

    const planar = new Float32Array(n * 2);
    planar.set(left.subarray(start, start + n), 0);
    planar.set(right.subarray(start, start + n), n);

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: OPUS_RATE,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round((start / OPUS_RATE) * 1e6),
      data: planar,
    });
    encoder.encode(audioData);
    audioData.close();

    // Don't let the encoder's queue grow huge, and keep the page responsive.
    while (encoder.encodeQueueSize > 20) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if ((start / CHUNK) % 10 === 0) {
      onProgress(`Encoding audio… ${Math.round((start / total) * 100)}%`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  await encoder.flush();
  encoder.close();
  if (encoderError) throw encoderError;
  if (packets.length === 0) throw new Error('The audio encoder produced no data.');

  return { packets, opusHead };
}