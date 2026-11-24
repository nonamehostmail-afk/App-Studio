import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPcm16FromWav,
  formatCueTime,
  mergeTimedWavClipsToMasterWav,
  parseTimedScript,
  parseTimestampToMs,
  pcmChunksToWavBase64,
  stripTimestampsForSpeech,
} from './timedScript';
import { base64ToUint8, float32ToPcm16Base64 } from './duckingMath';

test('parseTimestampToMs parses MM:SS, HH:MM:SS, and millisecond timestamps accurately', () => {
  assert.equal(parseTimestampToMs('00:05'), 5000);
  assert.equal(parseTimestampToMs('1:30'), 90000);
  assert.equal(parseTimestampToMs('00:02,500'), 2500);
  assert.equal(parseTimestampToMs('01:02:03.250'), 3723250);
  assert.equal(parseTimestampToMs('invalid'), null);
  assert.equal(formatCueTime(65400, true), '01:05.4');
});

test('parseTimedScript parses SRT blocks and inline timestamps while stripping timestamps from spoken text', () => {
  const srt = `1
00:00:02,000 --> 00:00:05,500
Привет всем зрителям!

2
00:00:08,250 --> 00:00:12,000
Вторая строка [00:09] без озвучки таймингов.
`;
  const srtCues = parseTimedScript(srt);
  assert.equal(srtCues.length, 2);
  assert.equal(srtCues[0].startMs, 2000);
  assert.equal(srtCues[0].cleanText, 'Привет всем зрителям!');
  assert.equal(srtCues[1].startMs, 8250);
  assert.equal(srtCues[1].cleanText, 'Вторая строка без озвучки таймингов.');

  const inline = `[00:10] Третья реплика
00:03 - Первая реплика
(00:06) Вторая реплика`;
  const inlineCues = parseTimedScript(inline);
  assert.equal(inlineCues.length, 3);
  // Chronologically sorted
  assert.equal(inlineCues[0].startMs, 3000);
  assert.equal(inlineCues[0].cleanText, 'Первая реплика');
  assert.equal(inlineCues[1].startMs, 6000);
  assert.equal(inlineCues[1].cleanText, 'Вторая реплика');
  assert.equal(inlineCues[2].startMs, 10000);
  assert.equal(inlineCues[2].cleanText, 'Третья реплика');
});

test('stripTimestampsForSpeech removes embedded timecodes, arrows, and tags cleanly', () => {
  assert.equal(
    stripTimestampsForSpeech('[00:12] <i>Текст</i> (00:15 - 00:18) без цифр времени'),
    'Текст без цифр времени',
  );
});

test('pcmChunksToWavBase64 and mergeTimedWavClipsToMasterWav build valid RIFF/WAVE files at exact offsets', () => {
  const tone = new Float32Array(2400); // 100ms at 24kHz
  for (let i = 0; i < tone.length; i++) {
    tone[i] = Math.sin((2 * Math.PI * 440 * i) / 24000) * 0.5;
  }
  const chunk = float32ToPcm16Base64(tone);
  const wavB64 = pcmChunksToWavBase64([chunk, chunk], 24000);
  assert.ok(wavB64.length > 100);

  const extracted = extractPcm16FromWav(base64ToUint8(wavB64));
  assert.ok(extracted !== null);
  assert.equal(extracted.sampleRate, 24000);
  assert.equal(extracted.samples.length, 4800);

  // Place clip 1 at 0ms and clip 2 at 500ms -> total length should be 500ms + 200ms = 700ms (16800 samples)
  const masterB64 = mergeTimedWavClipsToMasterWav(
    [
      { startMs: 0, wavBase64: wavB64 },
      { startMs: 500, wavBase64: wavB64 },
    ],
    24000,
  );
  const master = extractPcm16FromWav(base64ToUint8(masterB64));
  assert.ok(master !== null);
  assert.equal(master.samples.length, 16800);
  // Silence gap between 200ms (4800) and 500ms (12000) should be 0
  assert.equal(master.samples[8000], 0);
  // Clip 2 audio present after sample 12000
  let energyAfter500ms = 0;
  for (let i = 12000; i < 12500; i++) {
    energyAfter500ms += Math.abs(master.samples[i]);
  }
  assert.ok(energyAfter500ms > 10000);
});
