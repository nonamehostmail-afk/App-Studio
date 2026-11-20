export type DuckingMode =
  | 'replace_on_speech'
  | 'replace_always'
  | 'auto_duck'
  | 'passthrough';

export type VoiceName = 'Kore' | 'Fenrir' | 'Puck' | 'Charon' | 'Zephyr';

export type TtsModelId = 'gemini-3.8-flash-tts' | 'gemini-3.8-flash-lite-tts';

export type AppTab = 'console' | 'obs' | 'log';

export interface LanguageOption {
  code: string;
  label: string;
  nativeName: string;
}

export interface VoiceOption {
  id: VoiceName;
  label: string;
  character: string;
  defaultStyle: string;
}

export interface DuckingConfig {
  mode: DuckingMode;
  duckLevelDb: number; // -60 means complete mute (-Infinity dB)
  attackMs: number;
  holdMs: number;
  releaseMs: number;
  originalGainDb: number; // nominal original channel gain (0 dB default)
  ttsGainDb: number; // translated output gain (-12 to +6 dB)
  streamingTts: boolean;
}

export interface ObsOverlayConfig {
  showSubtitles: boolean;
  showOriginal: boolean;
  position: 'bottom' | 'top';
  fontSize: 'sm' | 'md' | 'lg';
  outputAudioInOverlay: boolean;
  previewBackdrop: 'transparent' | 'chroma' | 'dark';
}

export interface ObsWebSocketConfig {
  host: string;
  port: number;
  password: string;
  targetSourceName: string;
  autoControlSource: boolean;
}

export interface TranscriptEntry {
  id: string;
  timestamp: number;
  sourceLang: string;
  targetLang: string;
  originalText: string;
  translatedText: string;
  voiceName: VoiceName;
  ttsModel: TtsModelId;
  voiceStyle: string;
  translateMs: number;
  ttsMs: number;
  audioBase64Wav?: string;
  isDemo?: boolean;
}

export interface AudioLevels {
  originalPreDb: number;
  originalPostDb: number;
  ttsDb: number;
  masterDb: number;
  gainReductionDb: number;
  isDucking: boolean;
  isOriginalMuted: boolean;
}

export interface ObsBroadcastPayload {
  type: 'subtitle' | 'audio_wav' | 'duck_state' | 'config' | 'clear';
  id?: string;
  originalText?: string;
  translatedText?: string;
  audioBase64Wav?: string;
  isDucking?: boolean;
  isOriginalMuted?: boolean;
  gainReductionDb?: number;
  config?: Partial<ObsOverlayConfig>;
  timestamp?: number;
}
