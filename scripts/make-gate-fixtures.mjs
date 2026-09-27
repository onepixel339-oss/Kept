/**
 * Live-gate fixture generator — safe, deterministic, no user data.
 *  - image: PNG with printed text (vision extraction target)
 *  - audio: re-check the TTS WAV header (sample rate, channels)
 */
import sharp from "sharp";
import fs from "node:fs";

const OUT_DIR = "/home/z/my-project/kept/tests/fixtures/gate";

// ——— 1. Image fixture: a clean "note" with verbatim-extractable text ———
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">
  <rect width="800" height="500" fill="#fdf6e3"/>
  <rect x="40" y="40" width="720" height="420" fill="#ffffff" stroke="#d4c5a0" stroke-width="3" rx="12"/>
  <text x="400" y="130" font-family="DejaVu Sans, sans-serif" font-size="34" font-weight="bold" text-anchor="middle" fill="#333333">KEPT GATE TEST NOTE</text>
  <text x="400" y="210" font-family="DejaVu Sans, sans-serif" font-size="28" text-anchor="middle" fill="#444444">Dentist appointment</text>
  <text x="400" y="270" font-family="DejaVu Sans, sans-serif" font-size="28" text-anchor="middle" fill="#444444">Tuesday at 10:00</text>
  <text x="400" y="360" font-family="DejaVu Sans, sans-serif" font-size="22" text-anchor="middle" fill="#888888">Bring the insurance card</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(`${OUT_DIR}/gate-note.png`);
const png = fs.statSync(`${OUT_DIR}/gate-note.png`);
console.log(`image fixture: gate-note.png ${png.size} bytes`);

// ——— 2. WAV header sanity ———
const buf = fs.readFileSync(`${OUT_DIR}/gate-speech.wav`);
const riff = buf.subarray(0, 4).toString("ascii");
const wave = buf.subarray(8, 12).toString("ascii");
const sampleRate = buf.readUInt32LE(24);
const bitsPerSample = buf.readUInt16LE(34);
const seconds = (buf.length - 44) / (sampleRate * 2); // 16-bit mono assumption
console.log(
  `audio fixture: gate-speech.wav riff=${riff} wave=${wave} rate=${sampleRate} bits=${bitsPerSample} ~${seconds.toFixed(1)}s`
);
if (riff !== "RIFF" || wave !== "WAVE") throw new Error("invalid WAV fixture");
