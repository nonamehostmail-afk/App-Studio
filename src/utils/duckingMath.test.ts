import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SILENCE_DB,
  buildObsOverlayUrl,
  computeGainReductionDb,
  computeRmsDb,
  computeTargetOriginalGain,
  dbToGain,
  dbToMeterPercent,
  exportEntriesToSrt,
  float32ToPcm16Base64,
  formatDbLabel,
  gainToDb,
  generateObsLuaScript,
  pcm16Base64ToFloat32,
  resampleLinear,
} from './duckingMath';
import type { DuckingConfig, TranscriptEntry } from '../types/translator';

const baseConfig: DuckingConfig = {
  mode: 'replace_on_speech',
  duckLevelDb: -24,
  attackMs: 35,
  holdMs: 280,
  releaseMs: 320,
  originalGainDb: 0,
  ttsGainDb: 0,
  streamingTts: true,
};

test('dbToGain and gainToDb handle silence and nominal 0 dB accurately', () => {
  assert.equal(dbToGain(-60), 0);
  assert.equal(dbToGain(-90), 0);
  assert.equal(dbToGain(-Infinity), 0);
  assert.ok(Math.abs(dbToGain(0) - 1) < 1e-6);
  assert.ok(Math.abs(dbToGain(-6) - 0.501187) < 1e-4);
  assert.equal(gainToDb(0), SILENCE_DB);
  assert.ok(Math.abs(gainToDb(1) - 0) < 1e-6);
});

test('replace_on_speech completely mutes original audio while TTS speaks', () => {
  const idleGain = computeTargetOriginalGain(baseConfig, false, true);
  const speakingGain = computeTargetOriginalGain(baseConfig, true, true);
  assert.equal(idleGain, 1);
  assert.equal(speakingGain, 0);
  assert.equal(computeGainReductionDb(1, speakingGain), SILENCE_DB);
});

test('replace_always keeps original muted whenever translator is armed on-air', () => {
  const cfg: DuckingConfig = { ...baseConfig, mode: 'replace_always' };
  assert.equal(computeTargetOriginalGain(cfg, false, true), 0);
  assert.equal(computeTargetOriginalGain(cfg, true, true), 0);
  assert.equal(computeTargetOriginalGain(cfg, false, false), 1);
});

test('auto_duck attenuates original by exact duckLevelDb while speaking', () => {
  const cfg: DuckingConfig = {
    ...baseConfig,
    mode: 'auto_duck',
    duckLevelDb: -24,
  };
  const speakingGain = computeTargetOriginalGain(cfg, true, true);
  const reductionDb = computeGainReductionDb(1, speakingGain);
  assert.ok(Math.abs(reductionDb - -24) < 0.05);
  assert.equal(computeTargetOriginalGain(cfg, false, true), 1);
});

test('passthrough leaves original gain untouched even when speaking', () => {
  const cfg: DuckingConfig = { ...baseConfig, mode: 'passthrough' };
  assert.equal(computeTargetOriginalGain(cfg, true, true), 1);
});

test('PCM16 base64 encode/decode round-trips within 16-bit quantization tolerance', () => {
  const input = new Float32Array([-1, -0.5, 0, 0.25, 0.75, 0.99]);
  const b64 = float32ToPcm16Base64(input);
  const decoded = pcm16Base64ToFloat32(b64);
  assert.equal(decoded.length, input.length);
  for (let i = 0; i < input.length; i++) {
    assert.ok(Math.abs(decoded[i] - input[i]) < 0.001, `mismatch at ${i}`);
  }
});

test('resampleLinear downsamples 48kHz to 16kHz cleanly', () => {
  const input = new Float32Array(480);
  for (let i = 0; i < input.length; i++) {
    input[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
  }
  const output = resampleLinear(input, 48000, 16000);
  assert.equal(output.length, 160);
  assert.ok(computeRmsDb(output) > -10);
});

test('dbToMeterPercent and formatDbLabel format broadcast levels cleanly', () => {
  assert.equal(dbToMeterPercent(-60), 0);
  assert.equal(dbToMeterPercent(-30), 50);
  assert.equal(dbToMeterPercent(0), 100);
  assert.equal(formatDbLabel(-60), '-∞ дБ');
  assert.equal(formatDbLabel(-12), '-12.0 дБ');
  assert.equal(formatDbLabel(2.5), '+2.5 дБ');
});

test('exportEntriesToSrt produces valid numbered SRT blocks', () => {
  const entries: TranscriptEntry[] = [
    {
      id: '1',
      timestamp: 100000,
      sourceLang: 'en',
      targetLang: 'ru',
      originalText: 'Welcome everyone to the finals.',
      translatedText: 'Добро пожаловать на финал.',
      voiceName: 'Kore',
      ttsModel: 'gemini-3.8-flash-tts',
      voiceStyle: 'Диктор',
      translateMs: 180,
      ttsMs: 390,
    },
    {
      id: '2',
      timestamp: 103500,
      sourceLang: 'en',
      targetLang: 'ru',
      originalText: 'Let the match begin!',
      translatedText: 'Да начнётся матч!',
      voiceName: 'Kore',
      ttsModel: 'gemini-3.8-flash-tts',
      voiceStyle: 'Диктор',
      translateMs: 150,
      ttsMs: 340,
    },
  ];
  const srt = exportEntriesToSrt(entries);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:03,350\nДобро пожаловать на финал\./);
  assert.match(srt, /2\n00:00:03,500 --> 00:00:07,500\nДа начнётся матч!/);
});

test('buildObsOverlayUrl and generateObsLuaScript embed user configuration', () => {
  const url = buildObsOverlayUrl('https://studio.example.com/', {
    showSubtitles: true,
    showOriginal: false,
    position: 'bottom',
    fontSize: 'lg',
    outputAudioInOverlay: true,
    previewBackdrop: 'transparent',
  });
  assert.equal(
    url,
    'https://studio.example.com/?mode=obs&subs=1&orig=0&pos=bottom&size=lg&audio=1',
  );

  const lua = generateObsLuaScript({
    sourceName: 'Захват выходного звука',
    duckDb: -24,
    muteCompletely: true,
    overlayUrl: url,
  });
  assert.match(lua, /Захват выходного звука/);
  assert.match(lua, /mute_completely\s*=\s*true/);
  assert.match(lua, /obs_source_set_muted/);
});
