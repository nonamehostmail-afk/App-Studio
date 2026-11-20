import type {
  DuckingConfig,
  ObsOverlayConfig,
  TranscriptEntry,
} from '../types/translator';

export const SILENCE_DB = -60;

/**
 * Converts decibels to linear gain multiplier.
 * Values at or below -60 dB (or -Infinity) are treated as complete silence (0).
 */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= SILENCE_DB) {
    return 0;
  }
  return Math.pow(10, db / 20);
}

/**
 * Converts a linear amplitude/gain value to decibels, clamped to [-60, 12].
 */
export function gainToDb(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0.00099) {
    return SILENCE_DB;
  }
  const db = 20 * Math.log10(gain);
  return Math.max(SILENCE_DB, Math.min(12, db));
}

/**
 * Computes the target linear gain for the original audio channel based on the
 * selected replacement/ducking mode, whether Gemini TTS is actively speaking,
 * and whether the translator is armed on-air.
 */
export function computeTargetOriginalGain(
  config: DuckingConfig,
  isTtsSpeaking: boolean,
  isLiveArmed: boolean,
): number {
  const nominalGain = dbToGain(config.originalGainDb);

  switch (config.mode) {
    case 'passthrough':
      return nominalGain;

    case 'replace_always':
      // Permanently mute original audio while armed or when TTS is active
      return isLiveArmed || isTtsSpeaking ? 0 : nominalGain;

    case 'replace_on_speech':
      // Completely mute original audio (-Infinity dB) while translation is playing
      return isTtsSpeaking ? 0 : nominalGain;

    case 'auto_duck':
      // Attenuate original audio by duckLevelDb when translation is speaking
      if (!isTtsSpeaking) {
        return nominalGain;
      }
      if (config.duckLevelDb <= SILENCE_DB) {
        return 0;
      }
      return nominalGain * dbToGain(config.duckLevelDb);
  }
}

/**
 * Computes gain reduction in dB (0 or negative, down to -60 dB for full mute).
 */
export function computeGainReductionDb(
  nominalGain: number,
  currentGain: number,
): number {
  if (nominalGain <= 0.0001) return 0;
  if (currentGain <= 0.0001) return SILENCE_DB;
  const ratio = Math.min(1, Math.max(0, currentGain / nominalGain));
  return gainToDb(ratio);
}

/**
 * Computes RMS level in dBFS from a Float32 time-domain sample buffer.
 */
export function computeRmsDb(samples: Float32Array): number {
  if (samples.length === 0) return SILENCE_DB;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  return gainToDb(rms);
}

/**
 * Maps a dBFS value in [-60, 0] to a normalized 0..1 meter fill percentage.
 */
export function dbToMeterPercent(db: number): number {
  if (!Number.isFinite(db) || db <= SILENCE_DB) return 0;
  if (db >= 0) return 100;
  return ((db - SILENCE_DB) / Math.abs(SILENCE_DB)) * 100;
}

/**
 * Formats a decibel value for broadcast telemetry displays.
 */
export function formatDbLabel(db: number): string {
  if (!Number.isFinite(db) || db <= SILENCE_DB) {
    return '-∞ дБ';
  }
  const rounded = Math.round(db * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)} дБ`;
}

/**
 * Linearly resamples mono Float32 audio from source sample rate to target rate
 * (e.g. 48000 Hz -> 16000 Hz for Gemini Live Transcription).
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = srcPos - idx0;
    output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
  }
  return output;
}

/**
 * Encodes Float32 samples [-1, 1] into little-endian 16-bit PCM base64 string.
 */
export function float32ToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(i * 2, int16, true);
  }
  return uint8ToBase64(bytes);
}

/**
 * Decodes little-endian 16-bit PCM base64 string into Float32 samples [-1, 1].
 */
export function pcm16Base64ToFloat32(base64: string): Float32Array {
  const bytes = base64ToUint8(base64);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const output = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < sampleCount; i++) {
    output[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return output;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToUint8(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Formats epoch timestamp (ms) into HH:MM:SS broadcast timecode.
 */
export function formatTimecode(timestampMs: number): string {
  const date = new Date(timestampMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatSrtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(millis)}`;
}

/**
 * Exports broadcast translation entries to standard SubRip (.srt) format.
 */
export function exportEntriesToSrt(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return '';
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const baseTs = sorted[0].timestamp;

  return sorted
    .map((entry, idx) => {
      const startMs = Math.max(0, entry.timestamp - baseTs);
      const nextStart =
        idx < sorted.length - 1
          ? Math.max(startMs + 1500, sorted[idx + 1].timestamp - baseTs - 150)
          : startMs + 4000;
      const endMs = Math.min(startMs + 6000, nextStart);
      return `${idx + 1}\n${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}\n${entry.translatedText}\n`;
    })
    .join('\n');
}

/**
 * Builds the OBS Browser Source URL with overlay parameters encoded cleanly.
 */
export function buildObsOverlayUrl(
  origin: string,
  config: ObsOverlayConfig,
): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const params = new URLSearchParams({
    mode: 'obs',
    subs: config.showSubtitles ? '1' : '0',
    orig: config.showOriginal ? '1' : '0',
    pos: config.position,
    size: config.fontSize,
    audio: config.outputAudioInOverlay ? '1' : '0',
  });
  return `${cleanOrigin}/?${params.toString()}`;
}

/**
 * Generates a ready-to-import OBS Studio Lua plugin script that creates/manages
 * the DubCast Browser Source and provides hotkeys & automatic source muting.
 */
export function generateObsLuaScript(params: {
  sourceName: string;
  duckDb: number;
  muteCompletely: boolean;
  overlayUrl: string;
}): string {
  const safeSource = params.sourceName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeUrl = params.overlayUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const duckDbStr = params.muteCompletely ? '-100.0' : params.duckDb.toFixed(1);

  return `-- DubCast OBS — Плагин синхронного перевода (Gemini 3.8 Flash TTS)
-- Установка: OBS Studio -> Инструменты -> Скрипты -> "+" -> выбрать этот файл

obs = obslua

local original_source_name = "${safeSource}"
local browser_source_url   = "${safeUrl}"
local duck_attenuation_db  = ${duckDbStr}
local mute_completely      = ${params.muteCompletely ? 'true' : 'false'}
local is_replacing         = false
local saved_volume_mul     = 1.0
local hotkey_id            = obs.OBS_INVALID_HOTKEY_ID

function script_description()
  return [[
<h2>DubCast OBS — Замена звука переводом</h2>
<p>Глушит выбранный источник исходного звука и подменяет его живым переводом от Gemini 3.8 Flash TTS через Источник браузера OBS.</p>
<p>Настройте горячую клавишу в разделе <b>Настройки → Горячие клавиши → DubCast: Заменить оригинал переводом</b> или управляйте автоматически через OBS WebSocket v5.</p>
]]
end

function script_properties()
  local props = obs.obs_properties_create()
  local list = obs.obs_properties_add_list(
    props,
    "source_name",
    "Источник исходного звука (для заглушения)",
    obs.OBS_COMBO_TYPE_EDITABLE,
    obs.OBS_COMBO_FORMAT_STRING
  )

  local sources = obs.obs_enum_sources()
  if sources ~= nil then
    for _, src in ipairs(sources) do
      local name = obs.obs_source_get_name(src)
      obs.obs_property_list_add_string(list, name, name)
    end
    obs.source_list_release(sources)
  end

  obs.obs_properties_add_bool(props, "mute_completely", "Глушить исходный звук полностью (-∞ дБ)")
  obs.obs_properties_add_float_slider(props, "duck_db", "Уровень приглушения при дакинге (дБ)", -60.0, 0.0, 1.0)
  obs.obs_properties_add_text(props, "overlay_url", "URL Источника браузера DubCast", obs.OBS_TEXT_DEFAULT)
  obs.obs_properties_add_button(props, "toggle_btn", "Переключить заглушение сейчас", function()
    toggle_replacement(not is_replacing)
    return true
  end)

  return props
end

function script_defaults(settings)
  obs.obs_data_set_default_string(settings, "source_name", original_source_name)
  obs.obs_data_set_default_bool(settings, "mute_completely", mute_completely)
  obs.obs_data_set_default_double(settings, "duck_db", duck_attenuation_db)
  obs.obs_data_set_default_string(settings, "overlay_url", browser_source_url)
end

function script_update(settings)
  original_source_name = obs.obs_data_get_string(settings, "source_name")
  mute_completely      = obs.obs_data_get_bool(settings, "mute_completely")
  duck_attenuation_db  = obs.obs_data_get_double(settings, "duck_db")
  browser_source_url   = obs.obs_data_get_string(settings, "overlay_url")
end

function db_to_mul(db)
  if db <= -60.0 then return 0.0 end
  return 10.0 ^ (db / 20.0)
end

function toggle_replacement(enable)
  local source = obs.obs_get_source_by_name(original_source_name)
  if source == nil then
    obs.script_log(obs.LOG_WARNING, "[DubCast] Источник не найден: " .. original_source_name)
    return
  end

  if enable and not is_replacing then
    saved_volume_mul = obs.obs_source_get_volume(source)
    if mute_completely then
      obs.obs_source_set_muted(source, true)
    else
      obs.obs_source_set_volume(source, saved_volume_mul * db_to_mul(duck_attenuation_db))
    end
    is_replacing = true
    obs.script_log(obs.LOG_INFO, "[DubCast] Исходный звук заглушен — активна замена переводом.")
  elseif not enable and is_replacing then
    obs.obs_source_set_muted(source, false)
    obs.obs_source_set_volume(source, saved_volume_mul)
    is_replacing = false
    obs.script_log(obs.LOG_INFO, "[DubCast] Исходный звук восстановлен.")
  end

  obs.obs_source_release(source)
end

function on_hotkey(pressed)
  if not pressed then return end
  toggle_replacement(not is_replacing)
end

function script_load(settings)
  hotkey_id = obs.obs_hotkey_register_frontend("dubcast_toggle_replace", "DubCast: Заменить оригинал переводом", on_hotkey)
  local hotkey_save_array = obs.obs_data_get_array(settings, "dubcast_toggle_replace")
  obs.obs_hotkey_load(hotkey_id, hotkey_save_array)
  obs.obs_data_array_release(hotkey_save_array)
end

function script_save(settings)
  local hotkey_save_array = obs.obs_hotkey_save(hotkey_id)
  obs.obs_data_set_array(settings, "dubcast_toggle_replace", hotkey_save_array)
  obs.obs_data_array_release(hotkey_save_array)
end
`;
}
