import type {
  DuckingConfig,
  LanguageOption,
  ObsOverlayConfig,
  ObsWebSocketConfig,
  TranscriptEntry,
  VoiceOption,
} from '../types/translator';

export const SOURCE_LANGUAGES: LanguageOption[] = [
  { code: 'auto', label: 'Автоопределение', nativeName: 'Auto' },
  { code: 'en', label: 'Английский', nativeName: 'English' },
  { code: 'ru', label: 'Русский', nativeName: 'Русский' },
  { code: 'de', label: 'Немецкий', nativeName: 'Deutsch' },
  { code: 'es', label: 'Испанский', nativeName: 'Español' },
  { code: 'fr', label: 'Французский', nativeName: 'Français' },
  { code: 'ja', label: 'Японский', nativeName: '日本語' },
  { code: 'zh', label: 'Китайский', nativeName: '中文' },
  { code: 'ko', label: 'Корейский', nativeName: '한국어' },
  { code: 'uk', label: 'Украинский', nativeName: 'Українська' },
  { code: 'pt', label: 'Португальский', nativeName: 'Português' },
  { code: 'it', label: 'Итальянский', nativeName: 'Italiano' },
  { code: 'tr', label: 'Турецкий', nativeName: 'Türkçe' },
];

export const TARGET_LANGUAGES: LanguageOption[] = SOURCE_LANGUAGES.filter(
  (l) => l.code !== 'auto',
);

export const VOICE_OPTIONS: VoiceOption[] = [
  {
    id: 'Kore',
    label: 'Kore',
    character: 'Чёткий студийный диктор',
    defaultStyle: 'Уверенный диктор прямого эфира, ровная подача, чистая дикция',
  },
  {
    id: 'Fenrir',
    label: 'Fenrir',
    character: 'Глубокий баритон (спорт / эфир)',
    defaultStyle: 'Выразительный низкий голос спортивного комментатора, динамичный ритм',
  },
  {
    id: 'Puck',
    label: 'Puck',
    character: 'Энергичный ведущий стримов',
    defaultStyle: 'Живой и вовлечённый ведущий трансляции, естественная разговорная интонация',
  },
  {
    id: 'Charon',
    label: 'Charon',
    character: 'Спокойный документальный тембр',
    defaultStyle: 'Размеренный аналитический голос, мягкая студийная подача без спешки',
  },
  {
    id: 'Zephyr',
    label: 'Zephyr',
    character: 'Лёгкий разговорный голос',
    defaultStyle: 'Дружелюбный современный голос для интервью и подкастов, естественные паузы',
  },
];

export const STYLE_PRESETS: { label: string; prompt: string }[] = [
  {
    label: 'Диктор эфира',
    prompt: 'Уверенный диктор прямого эфира, ровная подача, чистая дикция, без лишних пауз',
  },
  {
    label: 'Киберспорт',
    prompt: 'Энергичный киберспортивный комментатор, быстрый темп, эмоциональные акценты',
  },
  {
    label: 'Синхронист конференции',
    prompt: 'Профессиональный синхронный переводчик технической конференции, точная деловая интонация',
  },
  {
    label: 'Подкаст / интервью',
    prompt: 'Естественный живой голос ведущего подкаста, тёплая разговорная интонация',
  },
];

export const SAMPLE_BROADCAST_PHRASES: {
  label: string;
  sourceLang: string;
  text: string;
}[] = [
  {
    label: 'Киберспорт (EN → RU)',
    sourceLang: 'en',
    text: 'What an unbelievable clutch in the final round! The crowd is on its feet and we are heading into overtime!',
  },
  {
    label: 'Презентация (EN → RU)',
    sourceLang: 'en',
    text: 'Today we are launching real-time neural voice translation with studio-grade latency directly inside your broadcast workflow.',
  },
  {
    label: 'Интервью (DE → RU)',
    sourceLang: 'de',
    text: 'Vielen Dank für die Einladung. Es ist großartig, heute live mit der gesamten Community zu sprechen.',
  },
];

export const DEFAULT_DUCKING_CONFIG: DuckingConfig = {
  mode: 'replace_on_speech',
  duckLevelDb: -24,
  attackMs: 35,
  holdMs: 280,
  releaseMs: 320,
  originalGainDb: 0,
  ttsGainDb: 0,
  streamingTts: true,
};

export const DEFAULT_OBS_OVERLAY_CONFIG: ObsOverlayConfig = {
  showSubtitles: true,
  showOriginal: true,
  position: 'bottom',
  fontSize: 'md',
  outputAudioInOverlay: true,
  previewBackdrop: 'dark',
};

export const DEFAULT_OBS_WS_CONFIG: ObsWebSocketConfig = {
  host: '127.0.0.1',
  port: 4455,
  password: '',
  targetSourceName: 'Захват выходного звука',
  autoControlSource: true,
};

const now = Date.now();
export const INITIAL_DEMO_LOG: TranscriptEntry[] = [
  {
    id: 'demo-1',
    timestamp: now - 142_000,
    sourceLang: 'en',
    targetLang: 'ru',
    originalText:
      'Welcome back to the main stage, everyone. Our finalists are taking their seats for game five.',
    translatedText:
      'С возвращением на главную сцену, друзья. Финалисты уже занимают свои места перед пятой решающей картой.',
    voiceName: 'Fenrir',
    ttsModel: 'gemini-3.8-flash-tts',
    voiceStyle: 'Энергичный киберспортивный комментатор',
    translateMs: 194,
    ttsMs: 412,
    isDemo: true,
  },
  {
    id: 'demo-2',
    timestamp: now - 88_000,
    sourceLang: 'en',
    targetLang: 'ru',
    originalText:
      'Notice how clean the audio replacement is — the original booth feed ducks completely while the Russian voice-over speaks.',
    translatedText:
      'Обратите внимание, насколько чисто работает замена звука — оригинальная дорожка полностью заглушается на время русской озвучки.',
    voiceName: 'Kore',
    ttsModel: 'gemini-3.8-flash-tts',
    voiceStyle: 'Уверенный диктор прямого эфира',
    translateMs: 210,
    ttsMs: 445,
    isDemo: true,
  },
];
