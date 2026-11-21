export type DuckingMode =
  | 'replace_on_speech'
  | 'replace_always'
  | 'auto_duck'
  | 'passthrough';

export type VoiceName = 'Kore' | 'Fenrir' | 'Puck' | 'Charon' | 'Zephyr';

export type TtsModelId = 'gemini-3.8-flash-tts' | 'gemini-3.8-flash-lite-tts';

export type AppTab = 'console' | 'cameras' | 'obs' | 'log';

export type TranslationProvider = 'gemini' | 'local';

export type LocalModelProtocol = 'ollama' | 'openai';

export type LocalModelTransport = 'browser_direct' | 'server_proxy';

export type CameraFilterMode =
  | 'none'
  | 'studio'
  | 'cool'
  | 'warm'
  | 'vignette'
  | 'bw';

export type ObsWsTransportMode = 'direct' | 'browser_source_bridge';

export interface LocalModelConfig {
  provider: TranslationProvider;
  protocol: LocalModelProtocol;
  transport: LocalModelTransport;
  baseUrl: string;
  modelName: string;
  apiKey: string;
  fallbackToGemini: boolean;
}

export interface CameraConfig {
  deviceId: string;
  resolution: '720p' | '1080p' | '360p';
  fps: 30 | 60;
  mirror: boolean;
  filter: CameraFilterMode;
  sendVisionToGemini: boolean;
  sendVideoToObs: boolean;
}

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
  showCameraPip: boolean;
  previewBackdrop: 'transparent' | 'chroma' | 'dark';
}

export interface ObsWebSocketConfig {
  host: string;
  port: number;
  password: string;
  useTls: boolean;
  transport: ObsWsTransportMode;
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
  translatorLabel?: string;
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
  type:
    | 'subtitle'
    | 'audio_wav'
    | 'duck_state'
    | 'config'
    | 'clear'
    | 'camera_frame'
    | 'obs_bridge_connect'
    | 'obs_bridge_disconnect'
    | 'obs_bridge_mute'
    | 'obs_bridge_volume'
    | 'obs_bridge_status';
  id?: string;
  originalText?: string;
  translatedText?: string;
  audioBase64Wav?: string;
  cameraFrameDataUrl?: string;
  isDucking?: boolean;
  isOriginalMuted?: boolean;
  gainReductionDb?: number;
  config?: Partial<ObsOverlayConfig>;
  bridgeConfig?: {
    host: string;
    port: number;
    password: string;
    useTls: boolean;
    targetSourceName: string;
  };
  bridgeState?: 'disconnected' | 'connecting' | 'connected' | 'error';
  bridgeMessage?: string;
  bridgeSources?: string[];
  muted?: boolean;
  volumeDb?: number;
  sourceName?: string;
  timestamp?: number;
}
