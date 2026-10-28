// ADTS AAC -> fragmented MP4, for browsers whose Media Source refuses raw AAC.
//
// WHY: the stream player feeds one Media Source with Jellyfin's ADTS AAC
// (DESIGN.md "Playback"). Chrome takes that as-is, but Firefox accepts neither
// audio/aac nor audio/mpeg in Media Source (measured 2026-10-27: only
// audio/mp4), and Apple's Media Source is built around MP4 too. Without this,
// those browsers drop to basic mode: MP3, gaps, and no song changes while the
// screen is off. Rewrapping is lossless: the AAC frames are copied byte for
// byte into MP4 boxes, nothing is decoded or re-encoded.
//
// One Mp4Muxer per song. push() takes fetched bytes (ADTS frames can be split
// across network chunks, so leftovers wait for the next push) and returns MP4
// bytes ready for appendBuffer: an init segment (codec setup) before the
// song's first fragment, then one fragment (moof + mdat) per push. A fresh
// init segment per song is allowed by Media Source and covers songs with a
// different sample rate (44.1 vs 48 kHz) without any special casing.

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const SAMPLES_PER_FRAME = 1024;   // AAC-LC: every frame decodes to 1024 samples
const TRACK = 1;

export class Mp4Muxer {
  constructor() {
    this.rest = new Uint8Array(0);  // bytes of an ADTS frame not complete yet
    this.config = null;             // {rate, channels, profile} once the first header is read
    this.decodeTime = 0;            // samples written so far (tfdt)
    this.seq = 0;                   // moof sequence number
  }

  push(bytes) {
    const data = concat([this.rest, bytes]);
    const frames = [];
    let i = 0;
    while (i + 7 <= data.length) {
      // Sync word 0xFFF; anything else means we lost alignment, so slide forward.
      if (data[i] !== 0xff || (data[i + 1] & 0xf6) !== 0xf0) { i++; continue; }
      const noCrc = data[i + 1] & 1;
      const header = noCrc ? 7 : 9;
      const len = ((data[i + 3] & 3) << 11) | (data[i + 4] << 3) | (data[i + 5] >> 5);
      if (len < header) { i++; continue; }
      if (i + len > data.length) break;   // rest of this frame is still on the wire
      if (!this.config) {
        this.config = {
          profile: (data[i + 2] >> 6) + 1,                         // audio object type (2 = AAC-LC)
          rate: RATES[(data[i + 2] >> 2) & 0xf] || 44100,
          rateIndex: (data[i + 2] >> 2) & 0xf,
          channels: ((data[i + 2] & 1) << 2) | (data[i + 3] >> 6),
        };
      }
      frames.push(data.subarray(i + header, i + len));
      i += len;
    }
    this.rest = data.slice(i);
    if (!frames.length) return new Uint8Array(0);
    const out = [];
    if (this.seq === 0) out.push(initSegment(this.config));
    out.push(fragment(frames, ++this.seq, this.decodeTime));
    this.decodeTime += frames.length * SAMPLES_PER_FRAME;
    return concat(out);
  }
}

// ---------- MP4 boxes (ISO/IEC 14496-12, the subset Media Source needs) ----------

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const u8 = (...v) => Uint8Array.from(v);
const u16 = (v) => u8(v >>> 8, v & 0xff);
const u32 = (v) => u8(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const zeros = (n) => new Uint8Array(n);

function box(type, ...payload) {
  const body = concat(payload);
  return concat([u32(body.length + 8), str(type), body]);
}
// "Full box": version byte + 24 bits of flags before the payload.
const fullBox = (type, version, flags, ...payload) =>
  box(type, u8(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), ...payload);

// Identity matrix for mvhd/tkhd (16.16 and 2.30 fixed point).
const MATRIX = concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);

function initSegment({ profile, rate, rateIndex, channels }) {
  // AudioSpecificConfig: object type (5 bits), rate index (4), channels (4), 3 zero bits.
  const asc = u8((profile << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (channels << 3));
  const esds = fullBox('esds', 0, 0,
    u8(0x03, 23 + asc.length), u16(TRACK), u8(0),           // ES_Descriptor
    u8(0x04, 15 + asc.length, 0x40, 0x15), zeros(3),        // DecoderConfig: MPEG-4 audio, audio stream
    u32(0), u32(0),                                         // max / average bitrate unknown
    u8(0x05, asc.length), asc,                              // DecoderSpecificInfo
    u8(0x06, 1, 2));                                        // SLConfig
  const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(channels), u16(16), zeros(4), u32((rate & 0xffff) * 65536), esds);
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), mp4a),
    fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stco', 0, 0, u32(0)));
  const minf = box('minf',
    fullBox('smhd', 0, 0, zeros(4)),
    box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
    stbl);
  const mdia = box('mdia',
    fullBox('mdhd', 0, 0, u32(0), u32(0), u32(rate), u32(0), u16(0x55c4), u16(0)),   // language "und"
    fullBox('hdlr', 0, 0, u32(0), str('soun'), zeros(12), str('SoundHandler\0')),
    minf);
  const trak = box('trak',
    fullBox('tkhd', 0, 3, u32(0), u32(0), u32(TRACK), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)),
    mdia);
  const moov = box('moov',
    fullBox('mvhd', 0, 0, u32(0), u32(0), u32(rate), u32(0), u32(0x10000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(TRACK + 1)),
    trak,
    box('mvex', fullBox('trex', 0, 0, u32(TRACK), u32(1), u32(0), u32(0), u32(0))));
  return concat([box('ftyp', str('iso6'), u32(1), str('iso6'), str('mp41')), moov]);
}

function fragment(frames, seq, decodeTime) {
  // trun flags: data offset present, per-sample duration and size present.
  const trunHeader = 12 + 8;                       // fullbox header + sample count + data offset
  const trunSize = trunHeader + frames.length * 8;
  const tfhdSize = 16, tfdtSize = 20, mfhdSize = 16;
  const moofSize = 8 + mfhdSize + 8 + tfhdSize + tfdtSize + trunSize;
  const samples = [];
  for (const f of frames) samples.push(u32(SAMPLES_PER_FRAME), u32(f.length));
  const moof = box('moof',
    fullBox('mfhd', 0, 0, u32(seq)),
    box('traf',
      fullBox('tfhd', 0, 0x020000, u32(TRACK)),                  // default-base-is-moof
      fullBox('tfdt', 1, 0, u32(Math.floor(decodeTime / 2 ** 32)), u32(decodeTime >>> 0)),
      fullBox('trun', 0, 0x000301, u32(frames.length), u32(moofSize + 8), ...samples)));
  return concat([moof, box('mdat', ...frames)]);
}
