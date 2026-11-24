import { base64ToUint8, uint8ToBase64 } from './duckingMath';

export interface TimedCue {
  id: string;
  index: number;
  startMs: number;
  endMs?: number;
  timeLabel: string;
  cleanText: string;
}

/**
 * Parses a timestamp token such as:
 * - "00:05" (MM:SS)
 * - "00:05.5" or "00:05,500" (MM:SS.ms)
 * - "01:02:03" or "01:02:03,250" (HH:MM:SS.ms)
 * Returns milliseconds or null if invalid.
 */
export function parseTimestampToMs(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.');
  const parts = cleaned.split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (parts.length === 3) {
    hours = Number(parts[0]);
    minutes = Number(parts[1]);
    seconds = Number(parts[2]);
  } else {
    minutes = Number(parts[0]);
    seconds = Number(parts[1]);
  }

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    hours < 0 ||
    minutes < 0 ||
    minutes >= 60 ||
    seconds < 0 ||
    seconds >= 60
  ) {
    return null;
  }

  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

/**
 * Formats milliseconds into a clean tabular display timecode (MM:SS or HH:MM:SS).
 */
export function formatCueTime(ms: number, includeTenths = false): string {
  const clamped = Math.max(0, Math.floor(ms));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const tenths = Math.floor((clamped % 1000) / 100);
  const pad = (n: number) => String(n).padStart(2, '0');
  const base =
    hours > 0
      ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(minutes)}:${pad(seconds)}`;
  return includeTenths ? `${base}.${tenths}` : base;
}

/**
 * Strips any remaining timestamp tokens, SRT arrows, bracketed timecodes, or HTML/VTT tags
 * so timestamps are NEVER spoken aloud by TTS.
 */
export function stripTimestampsForSpeech(text: string): string {
  return text
    // Remove HTML/VTT styling tags like <i>, <b>, <c>
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    // Remove bracketed or parenthesized timestamps/ranges e.g. [00:05], [00:05 - 00:10], (1:23.4)
    .replace(
      /[\[(]\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?:\s*(?:-->|->|-|–|—)\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)?\s*[\])]/g,
      ' ',
    )
    // Remove standalone timestamp ranges like 00:00:05,000 --> 00:00:08,500
    .replace(
      /\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\s*(?:-->|->|–|—|-)\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b/g,
      ' ',
    )
    // Remove standalone leading timestamp tokens
    .replace(
      /^\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\s*[:\-–—|]*\s*/,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

const SRT_RANGE_LINE_RE =
  /^\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(?:-->|->)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(.*)$/;

const INLINE_TIMED_LINE_RE =
  /^\s*[\[(]?\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)(?:\s*(?:-->|->|-|–|—)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?))?\s*[\])]?\s*(?:[:\-–—|]\s*|\s+)?(.*)$/;

/**
 * Parses a multi-line script containing timestamps (SRT, WebVTT, [MM:SS] Text, MM:SS - Text, HH:MM:SS Text)
 * into chronologically sorted cues with all timestamps stripped from `cleanText`.
 */
export function parseTimedScript(rawText: string): TimedCue[] {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const cues: Array<{ startMs: number; endMs?: number; textParts: string[] }> =
    [];

  let current: { startMs: number; endMs?: number; textParts: string[] } | null =
    null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      // Blank line terminates current SRT block cleanly
      if (current && current.textParts.length > 0) {
        cues.push(current);
        current = null;
      }
      continue;
    }

    // Ignore WebVTT header
    if (/^WEBVTT\b/i.test(trimmed)) {
      continue;
    }

    // Ignore pure numeric SRT cue index line if followed by a timestamp range line
    if (
      /^\d+$/.test(trimmed) &&
      i + 1 < lines.length &&
      SRT_RANGE_LINE_RE.test(lines[i + 1].trim())
    ) {
      if (current && current.textParts.length > 0) {
        cues.push(current);
        current = null;
      }
      continue;
    }

    // 1. Check SRT / VTT range line (00:00:05,000 --> 00:00:09,000 [optional inline text])
    const srtMatch = trimmed.match(SRT_RANGE_LINE_RE);
    if (srtMatch) {
      const startMs = parseTimestampToMs(srtMatch[1]);
      const endMs = parseTimestampToMs(srtMatch[2]) ?? undefined;
      if (startMs !== null) {
        if (current && current.textParts.length > 0) {
          cues.push(current);
        }
        const trailing = stripTimestampsForSpeech(srtMatch[3] || '');
        current = {
          startMs,
          endMs,
          textParts: trailing ? [trailing] : [],
        };
        continue;
      }
    }

    // 2. Check inline timed line ([00:05] Text, 00:05 - Text, 00:05 Text, 01:02:05 - 01:02:10 Text)
    const inlineMatch = trimmed.match(INLINE_TIMED_LINE_RE);
    if (inlineMatch) {
      const startMs = parseTimestampToMs(inlineMatch[1]);
      const endMs = inlineMatch[2]
        ? (parseTimestampToMs(inlineMatch[2]) ?? undefined)
        : undefined;
      if (startMs !== null) {
        if (current && current.textParts.length > 0) {
          cues.push(current);
        }
        const clean = stripTimestampsForSpeech(inlineMatch[3] || '');
        current = {
          startMs,
          endMs,
          textParts: clean ? [clean] : [],
        };
        continue;
      }
    }

    // 3. Continuation text belonging to the active timestamp block
    const cleanLine = stripTimestampsForSpeech(trimmed);
    if (cleanLine && current) {
      current.textParts.push(cleanLine);
    }
  }

  if (current && current.textParts.length > 0) {
    cues.push(current);
  }

  return cues
    .map((c) => ({
      startMs: c.startMs,
      endMs: c.endMs,
      cleanText: stripTimestampsForSpeech(c.textParts.join(' ')),
    }))
    .filter((c) => c.cleanText.length > 0)
    .sort((a, b) => a.startMs - b.startMs)
    .map((c, idx) => ({
      id: `cue-${idx}-${c.startMs}`,
      index: idx + 1,
      startMs: c.startMs,
      endMs: c.endMs,
      timeLabel: formatCueTime(c.startMs),
      cleanText: c.cleanText,
    }));
}

/**
 * Wraps raw signed 16-bit little-endian mono PCM bytes into a standard 44-byte RIFF/WAVE file.
 */
export function encodePcm16BytesToWav(
  pcmBytes: Uint8Array,
  sampleRate = 24000,
  numChannels = 1,
): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBytes.byteLength;
  const wav = new Uint8Array(44 + dataSize);
  const view = new DataView(wav.buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  wav.set(pcmBytes, 44);

  return wav;
}

/**
 * Concatenates an array of base64-encoded PCM16 (24kHz mono) chunks from streaming TTS
 * into a single downloadable base64 RIFF/WAV string.
 */
export function pcmChunksToWavBase64(
  pcmBase64Chunks: string[],
  sampleRate = 24000,
): string {
  if (pcmBase64Chunks.length === 0) return '';
  const decoded = pcmBase64Chunks.map((c) => base64ToUint8(c));
  const totalBytes = decoded.reduce((sum, b) => sum + b.byteLength, 0);
  if (totalBytes === 0) return '';
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of decoded) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const wavBytes = encodePcm16BytesToWav(combined, sampleRate, 1);
  return uint8ToBase64(wavBytes);
}

/**
 * Parses a standard PCM16 RIFF/WAVE buffer to extract sampleRate and Int16 mono samples.
 */
export function extractPcm16FromWav(wavBytes: Uint8Array): {
  sampleRate: number;
  samples: Int16Array;
} | null {
  if (wavBytes.byteLength < 44) return null;
  const view = new DataView(
    wavBytes.buffer,
    wavBytes.byteOffset,
    wavBytes.byteLength,
  );
  const riff = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (riff !== 'RIFF') return null;

  let sampleRate = 24000;
  let channels = 1;
  let offset = 12;

  while (offset + 8 <= wavBytes.byteLength) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;

    if (chunkId === 'fmt ' && bodyStart + 16 <= wavBytes.byteLength) {
      channels = Math.max(1, view.getUint16(bodyStart + 2, true));
      sampleRate = view.getUint32(bodyStart + 4, true) || 24000;
    } else if (chunkId === 'data') {
      const safeBytes = Math.min(chunkSize, wavBytes.byteLength - bodyStart);
      const frameCount = Math.floor(safeBytes / (2 * channels));
      const mono = new Int16Array(frameCount);
      for (let i = 0; i < frameCount; i++) {
        let acc = 0;
        for (let ch = 0; ch < channels; ch++) {
          acc += view.getInt16(bodyStart + (i * channels + ch) * 2, true);
        }
        mono[i] = Math.round(acc / channels);
      }
      return { sampleRate, samples: mono };
    }

    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  return null;
}

/**
 * Mixes multiple synthesized WAV clips onto a single master timeline at their exact `startMs`
 * timestamps and encodes the result as a downloadable base64 WAV file.
 */
export function mergeTimedWavClipsToMasterWav(
  clips: Array<{ startMs: number; wavBase64: string }>,
  targetSampleRate = 24000,
): string {
  const parsedClips: Array<{ startSample: number; samples: Int16Array }> = [];
  let maxSamples = 0;

  for (const clip of clips) {
    if (!clip.wavBase64) continue;
    const raw = base64ToUint8(clip.wavBase64);
    const extracted = extractPcm16FromWav(raw);
    if (!extracted || extracted.samples.length === 0) continue;

    // Resample linearly if WAV sample rate differs from targetSampleRate
    let samples = extracted.samples;
    if (extracted.sampleRate !== targetSampleRate) {
      const ratio = extracted.sampleRate / targetSampleRate;
      const outLen = Math.max(1, Math.round(samples.length / ratio));
      const resampled = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const idx0 = Math.floor(pos);
        const idx1 = Math.min(idx0 + 1, samples.length - 1);
        const frac = pos - idx0;
        resampled[i] = Math.round(
          samples[idx0] * (1 - frac) + samples[idx1] * frac,
        );
      }
      samples = resampled;
    }

    const startSample = Math.max(
      0,
      Math.round((clip.startMs / 1000) * targetSampleRate),
    );
    parsedClips.push({ startSample, samples });
    maxSamples = Math.max(maxSamples, startSample + samples.length);
  }

  if (maxSamples === 0) return '';

  // Cap master length to 15 minutes to prevent runaway memory if an accidental 10:00:00 timestamp is entered
  const maxAllowed = targetSampleRate * 60 * 15;
  const totalSamples = Math.min(maxSamples, maxAllowed);
  const mix = new Int32Array(totalSamples);

  for (const clip of parsedClips) {
    for (let i = 0; i < clip.samples.length; i++) {
      const dst = clip.startSample + i;
      if (dst >= totalSamples) break;
      mix[dst] += clip.samples[i];
    }
  }

  const pcmBytes = new Uint8Array(totalSamples * 2);
  const view = new DataView(pcmBytes.buffer);
  for (let i = 0; i < totalSamples; i++) {
    const clamped = Math.max(-32768, Math.min(32767, mix[i]));
    view.setInt16(i * 2, clamped, true);
  }

  const wavBytes = encodePcm16BytesToWav(pcmBytes, targetSampleRate, 1);
  return uint8ToBase64(wavBytes);
}

/**
 * Triggers a browser file download for a base64 WAV audio string.
 */
export function triggerWavDownload(base64Wav: string, filename: string): void {
  const bytes = base64ToUint8(base64Wav);
  const arrayBuf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuf).set(bytes);
  const blob = new Blob([arrayBuf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.wav') ? filename : `${filename}.wav`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const SAMPLE_TIMED_SCRIPT = `[00:01] Добро пожаловать на прямой эфир! Сейчас мы проверим синхронную озвучку по таймингам.
[00:07] Вторая строка запускается ровно на седьмой секунде — сами цифры таймингов не произносятся.
[00:14] А готовую озвучку можно сразу скачать в формате WAV из журнала эфира или одной дорожкой.`;
