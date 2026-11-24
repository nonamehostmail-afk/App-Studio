import { useRef, useState } from 'react';
import {
  Activity,
  AudioWaveform,
  Cpu,
  Mic,
  MicOff,
  Play,
  RefreshCw,
  Send,
  Square,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { BroadcastDuckingEngine } from '../audio/duckingEngine';
import {
  LOCAL_MODEL_PRESETS,
  SAMPLE_BROADCAST_PHRASES,
  SOURCE_LANGUAGES,
  STYLE_PRESETS,
  TARGET_LANGUAGES,
  VOICE_OPTIONS,
} from '../constants/presets';
import type {
  DuckingConfig,
  DuckingMode,
  LocalModelConfig,
  LocalModelProtocol,
  LocalModelTransport,
  TranscriptEntry,
  TtsModelId,
  VoiceName,
} from '../types/translator';
import { formatTimecode } from '../utils/duckingMath';
import { LevelMeters } from './LevelMeters';
import {
  TimedScriptPanel,
  type TimedCueSynthResult,
} from './TimedScriptPanel';
import type { TimedCue } from '../utils/timedScript';

interface ConsoleViewProps {
  engine: BroadcastDuckingEngine;
  isLive: boolean;
  onToggleLive: () => void;
  sourceLang: string;
  targetLang: string;
  onChangeSourceLang: (lang: string) => void;
  onChangeTargetLang: (lang: string) => void;
  voiceName: VoiceName;
  onChangeVoiceName: (v: VoiceName) => void;
  ttsModel: TtsModelId;
  onChangeTtsModel: (m: TtsModelId) => void;
  voiceStyle: string;
  onChangeVoiceStyle: (s: string) => void;
  duckingConfig: DuckingConfig;
  onChangeDuckingConfig: (next: DuckingConfig) => void;
  audioDevices: MediaDeviceInfo[];
  selectedDeviceId: string;
  onChangeDeviceId: (id: string) => void;
  monitorOriginal: boolean;
  onToggleMonitorOriginal: (val: boolean) => void;
  interimTranscript: string;
  isProcessing: boolean;
  processingStage: string;
  onTranslateAndSpeak: (text: string, overrideSourceLang?: string) => Promise<void>;
  onUploadAudioClip: (file: File) => Promise<void>;
  onSynthesizeTimedCue: (
    cleanText: string,
    shouldTranslate: boolean,
  ) => Promise<TimedCueSynthResult>;
  onPlayTimedCue: (cue: TimedCue, synth: TimedCueSynthResult) => void;
  recentEntries: TranscriptEntry[];
  onReplayEntry: (entry: TranscriptEntry) => void;
  onStopAudio: () => void;
  localModelConfig: LocalModelConfig;
  onChangeLocalModelConfig: (next: LocalModelConfig) => void;
  discoveredLocalModels: string[];
  localModelStatus: {
    state: 'idle' | 'loading' | 'ok' | 'error';
    message: string;
  };
  onFetchLocalModels: () => Promise<void>;
  onTestLocalModel: () => Promise<void>;
}

const DUCKING_MODES: { id: DuckingMode; label: string; hint: string }[] = [
  {
    id: 'replace_on_speech',
    label: 'Полная замена',
    hint: 'Глушит оригинал до -∞ дБ на время озвучки перевода',
  },
  {
    id: 'replace_always',
    label: 'Всегда глушить',
    hint: 'Исходный звук выключен постоянно в эфире — слышен только перевод',
  },
  {
    id: 'auto_duck',
    label: 'Авто-дакинг',
    hint: 'Плавно приглушает оригинал на заданный уровень (дБ) под перевод',
  },
  {
    id: 'passthrough',
    label: 'Без заглушения',
    hint: 'Оригинал и перевод звучат одновременно без подавления',
  },
];

export function ConsoleView({
  engine,
  isLive,
  onToggleLive,
  sourceLang,
  targetLang,
  onChangeSourceLang,
  onChangeTargetLang,
  voiceName,
  onChangeVoiceName,
  ttsModel,
  onChangeTtsModel,
  voiceStyle,
  onChangeVoiceStyle,
  duckingConfig,
  onChangeDuckingConfig,
  audioDevices,
  selectedDeviceId,
  onChangeDeviceId,
  monitorOriginal,
  onToggleMonitorOriginal,
  interimTranscript,
  isProcessing,
  processingStage,
  onTranslateAndSpeak,
  onUploadAudioClip,
  onSynthesizeTimedCue,
  onPlayTimedCue,
  recentEntries,
  onReplayEntry,
  onStopAudio,
  localModelConfig,
  onChangeLocalModelConfig,
  discoveredLocalModels,
  localModelStatus,
  onFetchLocalModels,
  onTestLocalModel,
}: ConsoleViewProps) {
  const [composerTab, setComposerTab] = useState<'live' | 'timed'>('live');
  const [manualText, setManualText] = useState('');
  const [manualError, setManualError] = useState('');
  const [isTestingDsp, setIsTestingDsp] = useState(false);
  const stopTestRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeModeMeta =
    DUCKING_MODES.find((m) => m.id === duckingConfig.mode) || DUCKING_MODES[0];

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = manualText.trim();
    if (!trimmed) {
      setManualError('Введите фразу для перевода и озвучки.');
      return;
    }
    setManualError('');
    await onTranslateAndSpeak(trimmed);
    setManualText('');
  };

  const handleToggleDspTest = () => {
    if (isTestingDsp) {
      stopTestRef.current?.();
      stopTestRef.current = null;
      setIsTestingDsp(false);
      return;
    }
    setIsTestingDsp(true);
    stopTestRef.current = engine.runDemoDuckingTest(() => {
      setIsTestingDsp(false);
      stopTestRef.current = null;
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    await onUploadAudioClip(file);
  };

  return (
    <div className="space-y-6">
      {/* Row 1: Signal Meters + Live Dubbing Composer */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7 space-y-6">
          {/* Broadcast Level Meters */}
          <LevelMeters engine={engine} modeLabel={activeModeMeta.label} />

          {/* Audio Replacement & Ducking Processor */}
          <section className="bg-[#121620] border border-white/[0.08] rounded-lg p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-[#F1F5F9]">
                  Процессор заглушения и замены звука
                </h2>
                <p className="text-xs text-[#8B95A7] mt-0.5">
                  {activeModeMeta.hint}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleToggleDspTest}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                    isTestingDsp
                      ? 'bg-[#F59E0B] text-[#0B0E14]'
                      : 'bg-[#1C2230] text-[#E6ECF5] hover:bg-[#252D40] border border-white/[0.08]'
                  }`}
                >
                  <Activity className="w-3.5 h-3.5" />
                  {isTestingDsp ? 'Остановить тест' : 'Тест заглушения'}
                </button>
                <button
                  type="button"
                  onClick={onStopAudio}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[#1C2230] text-[#CBD5E1] hover:bg-[#252D40] border border-white/[0.08] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                  aria-label="Остановить воспроизведение перевода"
                >
                  <Square className="w-3 h-3" />
                  Стоп звук
                </button>
              </div>
            </div>

            {/* Replacement Mode Segmented Control */}
            <div
              role="group"
              aria-label="Режим заглушения исходного звука"
              className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 p-1 bg-[#0B0E14] rounded-md border border-white/[0.06] mb-5"
            >
              {DUCKING_MODES.map((m) => {
                const active = duckingConfig.mode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onChangeDuckingConfig({ ...duckingConfig, mode: m.id })
                    }
                    className={`px-3 py-2 rounded text-xs font-medium transition-colors whitespace-nowrap truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                      active
                        ? 'bg-[#E11D48] text-white'
                        : 'text-[#94A3B8] hover:text-[#F1F5F9] hover:bg-white/[0.04]'
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>

            {/* Faders Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <label htmlFor="duck-level-slider" className="text-[#CBD5E1]">
                    Уровень приглушения (при авто-дакинге)
                  </label>
                  <span className="font-mono tabular-nums text-[#F1F5F9]">
                    {duckingConfig.duckLevelDb <= -60
                      ? '-∞ дБ (мут)'
                      : `${duckingConfig.duckLevelDb} дБ`}
                  </span>
                </div>
                <input
                  id="duck-level-slider"
                  type="range"
                  min={-60}
                  max={-6}
                  step={1}
                  disabled={duckingConfig.mode !== 'auto_duck'}
                  value={duckingConfig.duckLevelDb}
                  onChange={(e) =>
                    onChangeDuckingConfig({
                      ...duckingConfig,
                      duckLevelDb: Number(e.target.value),
                    })
                  }
                  className="studio-fader w-full disabled:opacity-40"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <label htmlFor="tts-gain-slider" className="text-[#CBD5E1]">
                    Усиление голоса перевода (TTS Out)
                  </label>
                  <span className="font-mono tabular-nums text-[#34D399]">
                    {duckingConfig.ttsGainDb > 0
                      ? `+${duckingConfig.ttsGainDb} дБ`
                      : `${duckingConfig.ttsGainDb} дБ`}
                  </span>
                </div>
                <input
                  id="tts-gain-slider"
                  type="range"
                  min={-12}
                  max={6}
                  step={1}
                  value={duckingConfig.ttsGainDb}
                  onChange={(e) =>
                    onChangeDuckingConfig({
                      ...duckingConfig,
                      ttsGainDb: Number(e.target.value),
                    })
                  }
                  className="studio-fader w-full"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <label htmlFor="attack-slider" className="text-[#CBD5E1]">
                    Атака заглушения
                  </label>
                  <span className="font-mono tabular-nums text-[#94A3B8]">
                    {duckingConfig.attackMs} мс
                  </span>
                </div>
                <input
                  id="attack-slider"
                  type="range"
                  min={10}
                  max={250}
                  step={5}
                  value={duckingConfig.attackMs}
                  onChange={(e) =>
                    onChangeDuckingConfig({
                      ...duckingConfig,
                      attackMs: Number(e.target.value),
                    })
                  }
                  className="studio-fader w-full"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <label htmlFor="release-slider" className="text-[#CBD5E1]">
                    Возврат оригинала
                  </label>
                  <span className="font-mono tabular-nums text-[#94A3B8]">
                    {duckingConfig.releaseMs} мс
                  </span>
                </div>
                <input
                  id="release-slider"
                  type="range"
                  min={80}
                  max={1200}
                  step={20}
                  value={duckingConfig.releaseMs}
                  onChange={(e) =>
                    onChangeDuckingConfig({
                      ...duckingConfig,
                      releaseMs: Number(e.target.value),
                    })
                  }
                  className="studio-fader w-full"
                />
              </div>
            </div>

            {/* Hardware Input & Monitoring Row */}
            <div className="mt-5 pt-4 border-t border-white/[0.06] grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-6">
                <label
                  htmlFor="audio-input-select"
                  className="block text-xs text-[#8B95A7] mb-1.5"
                >
                  Источник захвата речи (микрофон / VB-Cable)
                </label>
                <select
                  id="audio-input-select"
                  value={selectedDeviceId}
                  onChange={(e) => onChangeDeviceId(e.target.value)}
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
                >
                  <option value="">Системный вход по умолчанию</option>
                  {audioDevices.map((d, idx) => (
                    <option key={d.deviceId || idx} value={d.deviceId}>
                      {d.label || `Аудиовход ${idx + 1}`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-3">
                <button
                  type="button"
                  onClick={() => onToggleMonitorOriginal(!monitorOriginal)}
                  aria-pressed={monitorOriginal}
                  className={`w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                    monitorOriginal
                      ? 'bg-[#1C2230] border-[#38BDF8]/50 text-[#38BDF8]'
                      : 'bg-[#0B0E14] border-white/[0.08] text-[#94A3B8] hover:text-[#F1F5F9]'
                  }`}
                >
                  {monitorOriginal ? (
                    <Volume2 className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <VolumeX className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span>{monitorOriginal ? 'Монитор: ВКЛ' : 'Монитор: ВЫКЛ'}</span>
                </button>
              </div>

              <div className="sm:col-span-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isProcessing}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08] transition-colors whitespace-nowrap disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                >
                  <Upload className="w-3.5 h-3.5 shrink-0" />
                  <span>Аудиофайл</span>
                </button>
              </div>
            </div>
          </section>

          {/* Live Speech Capture, Manual Dubbing & Timed Script Desk */}
          <section className="bg-[#121620] border border-white/[0.08] rounded-lg p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-[#F1F5F9]">
                  {composerTab === 'live'
                    ? 'Живой захват речи и мгновенная озвучка'
                    : 'Чтение текста по таймингам'}
                </h2>
                <p className="text-xs text-[#8B95A7] mt-0.5">
                  {composerTab === 'live'
                    ? 'Говорите в микрофон или введите фразу — перевод сразу заглушит оригинал и пойдёт в OBS'
                    : 'Строки озвучиваются ровно в указанное время — сами тайминги в речь не читаются'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div
                  role="tablist"
                  aria-label="Режим ввода текста для озвучки"
                  className="inline-flex p-0.5 bg-[#0B0E14] rounded-md border border-white/[0.08]"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={composerTab === 'live'}
                    onClick={() => setComposerTab('live')}
                    className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                      composerTab === 'live'
                        ? 'bg-[#1C2230] text-white'
                        : 'text-[#8B95A7] hover:text-white'
                    }`}
                  >
                    Реплика и микрофон
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={composerTab === 'timed'}
                    onClick={() => setComposerTab('timed')}
                    className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                      composerTab === 'timed'
                        ? 'bg-[#1C2230] text-white'
                        : 'text-[#8B95A7] hover:text-white'
                    }`}
                  >
                    Текст по таймингам
                  </button>
                </div>

                {composerTab === 'live' && (
                  <button
                    type="button"
                    onClick={onToggleLive}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                      isLive
                        ? 'bg-[#E11D48] text-white hover:bg-[#BE123C]'
                        : 'bg-[#1C2230] text-[#E6ECF5] hover:bg-[#252D40] border border-white/[0.08]'
                    }`}
                  >
                    {isLive ? (
                      <>
                        <MicOff className="w-3.5 h-3.5" />
                        Остановить микрофон
                      </>
                    ) : (
                      <>
                        <Mic className="w-3.5 h-3.5" />
                        Захват с микрофона
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>

            <div className={composerTab === 'live' ? 'block' : 'hidden'}>
              {/* Live Recognition Strip */}
              {(isLive || interimTranscript || isProcessing) && (
                <div className="mb-4 px-3.5 py-2.5 rounded-md bg-[#0B0E14] border border-white/[0.08] flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-[#8B95A7] mb-0.5">
                      {isProcessing
                        ? processingStage
                        : isLive
                          ? 'Распознавание речи в реальном времени (Gemini 3.5 Live Transcribe)'
                          : 'Последний распознанный фрагмент'}
                    </div>
                    <p className="text-sm text-[#F1F5F9] truncate">
                      {interimTranscript ||
                        (isLive
                          ? 'Слушаю входной канал… начните говорить'
                          : processingStage)}
                    </p>
                  </div>
                  {isLive && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-mono text-[#FB7185] shrink-0">
                      <span className="w-2 h-2 rounded-full bg-[#E11D48] animate-pulse" />
                      REC
                    </span>
                  )}
                </div>
              )}

              {/* Manual Phrase Input Form */}
              <form onSubmit={handleManualSubmit} className="space-y-3" noValidate>
                <div>
                  <label htmlFor="manual-phrase-input" className="sr-only">
                    Фраза для перевода и озвучки
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2.5">
                    <input
                      id="manual-phrase-input"
                      type="text"
                      value={manualText}
                      onChange={(e) => {
                        setManualText(e.target.value);
                        if (manualError) setManualError('');
                      }}
                      placeholder="Введите или вставьте реплику для живого перевода и озвучки…"
                      className="flex-1 bg-[#0B0E14] border border-white/[0.1] rounded-md px-3.5 py-2.5 text-sm text-[#F1F5F9] placeholder:text-[#64748B] focus:outline-none focus:border-[#E11D48]"
                    />
                    <button
                      type="submit"
                      disabled={isProcessing}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-xs font-semibold bg-[#E11D48] hover:bg-[#BE123C] text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      <Send className="w-3.5 h-3.5" />
                      {isProcessing ? 'Синтез…' : 'Перевести и озвучить'}
                    </button>
                  </div>
                  {manualError && (
                    <p role="alert" className="mt-1.5 text-xs text-[#FB7185]">
                      {manualError}
                    </p>
                  )}
                </div>

                {/* Quick Broadcast Sample Buttons */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs text-[#64748B]">
                    Примеры реплик:
                  </span>
                  {SAMPLE_BROADCAST_PHRASES.map((sample) => (
                    <button
                      key={sample.label}
                      type="button"
                      disabled={isProcessing}
                      onClick={() => {
                        setManualText(sample.text);
                        setManualError('');
                        void onTranslateAndSpeak(sample.text, sample.sourceLang);
                      }}
                      className="px-2.5 py-1 rounded text-xs text-[#CBD5E1] bg-[#1C2230] hover:bg-[#252D40] border border-white/[0.06] transition-colors whitespace-nowrap disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                    >
                      {sample.label}
                    </button>
                  ))}
                </div>
              </form>
            </div>

            <div className={composerTab === 'timed' ? 'block' : 'hidden'}>
              <TimedScriptPanel
                onSynthesizeCue={onSynthesizeTimedCue}
                onPlayTimedCue={onPlayTimedCue}
                onStopAudio={onStopAudio}
                voiceName={voiceName}
                ttsModel={ttsModel}
                voiceStyle={voiceStyle}
                targetLang={targetLang}
              />
            </div>
          </section>
        </div>

        {/* Right Column: Language + Gemini 3.8 Flash TTS Voice Design + Recent Feed */}
        <div className="xl:col-span-5 space-y-6">
          <section className="bg-[#121620] border border-white/[0.08] rounded-lg p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-[#F1F5F9]">
                Языки и голос Gemini 3.8 Flash TTS
              </h2>
              <p className="text-xs text-[#8B95A7] mt-0.5">
                Модель синтеза, тембр диктора и режиссура интонации
              </p>
            </div>

            {/* Language Pair */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="source-lang-select"
                  className="block text-xs text-[#8B95A7] mb-1.5"
                >
                  Язык оригинала
                </label>
                <select
                  id="source-lang-select"
                  value={sourceLang}
                  onChange={(e) => onChangeSourceLang(e.target.value)}
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
                >
                  {SOURCE_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="target-lang-select"
                  className="block text-xs text-[#8B95A7] mb-1.5"
                >
                  Язык перевода
                </label>
                <select
                  id="target-lang-select"
                  value={targetLang}
                  onChange={(e) => onChangeTargetLang(e.target.value)}
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
                >
                  {TARGET_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Translation Model Provider: Gemini Cloud vs Local LLM (Ollama / LM Studio / llama.cpp) */}
            <div className="pt-3 border-t border-white/[0.06] space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[#8B95A7]">
                  Модель перевода текста
                </span>
                {localModelConfig.provider === 'local' && (
                  <span className="text-[11px] font-mono text-[#38BDF8] truncate">
                    {localModelConfig.modelName || 'Локальная LLM'}
                  </span>
                )}
              </div>
              <div
                role="group"
                aria-label="Выбор провайдера перевода"
                className="grid grid-cols-2 gap-1.5 p-1 bg-[#0B0E14] rounded-md border border-white/[0.06]"
              >
                <button
                  type="button"
                  aria-pressed={localModelConfig.provider === 'gemini'}
                  onClick={() =>
                    onChangeLocalModelConfig({
                      ...localModelConfig,
                      provider: 'gemini',
                    })
                  }
                  className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors truncate ${
                    localModelConfig.provider === 'gemini'
                      ? 'bg-[#E11D48] text-white'
                      : 'text-[#94A3B8] hover:text-white'
                  }`}
                >
                  Gemini (облако)
                </button>
                <button
                  type="button"
                  aria-pressed={localModelConfig.provider === 'local'}
                  onClick={() =>
                    onChangeLocalModelConfig({
                      ...localModelConfig,
                      provider: 'local',
                    })
                  }
                  className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors truncate ${
                    localModelConfig.provider === 'local'
                      ? 'bg-[#E11D48] text-white'
                      : 'text-[#94A3B8] hover:text-white'
                  }`}
                >
                  <Cpu className="w-3.5 h-3.5 shrink-0" />
                  <span>Локальная модель</span>
                </button>
              </div>

              {localModelConfig.provider === 'local' && (
                <div className="space-y-3 pt-1">
                  {/* Quick Server Presets */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {LOCAL_MODEL_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() =>
                          onChangeLocalModelConfig({
                            ...localModelConfig,
                            protocol: preset.protocol,
                            baseUrl: preset.baseUrl,
                            modelName: preset.modelName,
                          })
                        }
                        className="px-2 py-1 rounded text-[11px] text-[#CBD5E1] bg-[#1C2230] hover:bg-[#252D40] border border-white/[0.06] transition-colors"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label
                        htmlFor="local-proto-select"
                        className="block text-[11px] text-[#8B95A7] mb-1"
                      >
                        Протокол API
                      </label>
                      <select
                        id="local-proto-select"
                        value={localModelConfig.protocol}
                        onChange={(e) =>
                          onChangeLocalModelConfig({
                            ...localModelConfig,
                            protocol: e.target.value as LocalModelProtocol,
                          })
                        }
                        className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-2.5 py-1.5 text-xs text-[#F1F5F9]"
                      >
                        <option value="ollama">Ollama (/api/chat)</option>
                        <option value="openai">OpenAI (/v1/chat)</option>
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor="local-transport-select"
                        className="block text-[11px] text-[#8B95A7] mb-1"
                      >
                        Маршрут запроса
                      </label>
                      <select
                        id="local-transport-select"
                        value={localModelConfig.transport}
                        onChange={(e) =>
                          onChangeLocalModelConfig({
                            ...localModelConfig,
                            transport: e.target.value as LocalModelTransport,
                          })
                        }
                        className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-2.5 py-1.5 text-xs text-[#F1F5F9]"
                      >
                        <option value="browser_direct">Из браузера (localhost)</option>
                        <option value="server_proxy">Через сервер (URL/туннель)</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="local-url-input"
                      className="block text-[11px] text-[#8B95A7] mb-1"
                    >
                      Адрес локального сервера
                    </label>
                    <input
                      id="local-url-input"
                      type="text"
                      value={localModelConfig.baseUrl}
                      onChange={(e) =>
                        onChangeLocalModelConfig({
                          ...localModelConfig,
                          baseUrl: e.target.value,
                        })
                      }
                      placeholder="http://localhost:11434"
                      className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-1.5 text-xs font-mono text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="local-model-input"
                      className="block text-[11px] text-[#8B95A7] mb-1"
                    >
                      Имя модели (например, qwen2.5:7b, llama3.1:8b, gemma3:12b)
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="local-model-input"
                        type="text"
                        value={localModelConfig.modelName}
                        onChange={(e) =>
                          onChangeLocalModelConfig({
                            ...localModelConfig,
                            modelName: e.target.value,
                          })
                        }
                        placeholder="qwen2.5:7b"
                        className="flex-1 bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-1.5 text-xs font-mono text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
                      />
                      <button
                        type="button"
                        onClick={() => void onFetchLocalModels()}
                        disabled={localModelStatus.state === 'loading'}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08] whitespace-nowrap disabled:opacity-50"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Список
                      </button>
                    </div>
                    {discoveredLocalModels.length > 0 && (
                      <select
                        aria-label="Найденные локальные модели"
                        value={localModelConfig.modelName}
                        onChange={(e) =>
                          onChangeLocalModelConfig({
                            ...localModelConfig,
                            modelName: e.target.value,
                          })
                        }
                        className="w-full mt-1.5 bg-[#0B0E14] border border-white/[0.1] rounded-md px-2.5 py-1.5 text-xs font-mono text-[#38BDF8]"
                      >
                        {discoveredLocalModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="local-fallback-toggle"
                      className="text-[11px] text-[#94A3B8]"
                    >
                      Запасной перевод через Gemini при ошибке
                    </label>
                    <input
                      id="local-fallback-toggle"
                      type="checkbox"
                      checked={localModelConfig.fallbackToGemini}
                      onChange={(e) =>
                        onChangeLocalModelConfig({
                          ...localModelConfig,
                          fallbackToGemini: e.target.checked,
                        })
                      }
                      className="w-3.5 h-3.5 accent-[#E11D48] cursor-pointer"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => void onTestLocalModel()}
                      disabled={localModelStatus.state === 'loading'}
                      className="px-3 py-1.5 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#F1F5F9] border border-white/[0.1] disabled:opacity-50"
                    >
                      {localModelStatus.state === 'loading'
                        ? 'Проверка…'
                        : 'Проверить локальную модель'}
                    </button>
                    <span className="text-[10px] font-mono text-[#64748B]">
                      CORS: OLLAMA_ORIGINS=*
                    </span>
                  </div>

                  {localModelStatus.message && (
                    <p
                      role={localModelStatus.state === 'error' ? 'alert' : 'status'}
                      className={`text-[11px] leading-relaxed ${
                        localModelStatus.state === 'error'
                          ? 'text-[#FB7185]'
                          : 'text-[#34D399]'
                      }`}
                    >
                      {localModelStatus.message}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* TTS Model Selector */}
            <div>
              <label
                htmlFor="tts-model-select"
                className="block text-xs text-[#8B95A7] mb-1.5"
              >
                Модель озвучки
              </label>
              <select
                id="tts-model-select"
                value={ttsModel}
                onChange={(e) => onChangeTtsModel(e.target.value as TtsModelId)}
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs font-mono text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
              >
                <option value="gemini-3.8-flash-tts">
                  gemini-3.8-flash-tts (Флагман · Voice Design)
                </option>
                <option value="gemini-3.8-flash-lite-tts">
                  gemini-3.8-flash-lite-tts (Мин. задержка)
                </option>
              </select>
            </div>

            {/* Voice Selection Grid */}
            <div>
              <span className="block text-xs text-[#8B95A7] mb-1.5">
                Голос диктора
              </span>
              <div className="grid grid-cols-1 gap-1.5">
                {VOICE_OPTIONS.map((v) => {
                  const selected = voiceName === v.id;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        onChangeVoiceName(v.id);
                      }}
                      className={`flex items-center justify-between px-3 py-2 rounded-md text-left border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                        selected
                          ? 'bg-[#1D2434] border-[#E11D48] text-[#F8FAFC]'
                          : 'bg-[#0B0E14] border-white/[0.06] text-[#CBD5E1] hover:border-white/[0.15]'
                      }`}
                    >
                      <span className="text-xs font-semibold font-display">
                        {v.label}
                      </span>
                      <span className="text-xs text-[#8B95A7] truncate ml-3">
                        {v.character}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Voice Design Style Prompt (speechMetadata.style) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="voice-style-input"
                  className="text-xs text-[#8B95A7]"
                >
                  Стиль подачи (Voice Design · speechMetadata.style)
                </label>
              </div>
              <textarea
                id="voice-style-input"
                rows={2}
                value={voiceStyle}
                onChange={(e) => onChangeVoiceStyle(e.target.value)}
                placeholder="Опишите манеру речи, темп, интонацию диктора…"
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs text-[#F1F5F9] placeholder:text-[#64748B] focus:outline-none focus:border-[#E11D48] resize-none"
              />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {STYLE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => onChangeVoiceStyle(preset.prompt)}
                    className="px-2 py-1 rounded text-[11px] text-[#94A3B8] hover:text-[#F1F5F9] bg-[#1C2230] hover:bg-[#252D40] transition-colors whitespace-nowrap"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Streaming Mode Toggle */}
            <div className="pt-3 border-t border-white/[0.06] flex items-center justify-between gap-3">
              <div>
                <label
                  htmlFor="streaming-tts-toggle"
                  className="text-xs font-medium text-[#E6ECF5] block"
                >
                  Потоковый синтез PCM (24 кГц)
                </label>
                <span className="text-[11px] text-[#8B95A7]">
                  Начинает воспроизведение перевода с первых чанков
                </span>
              </div>
              <input
                id="streaming-tts-toggle"
                type="checkbox"
                checked={duckingConfig.streamingTts}
                onChange={(e) =>
                  onChangeDuckingConfig({
                    ...duckingConfig,
                    streamingTts: e.target.checked,
                  })
                }
                className="w-4 h-4 accent-[#E11D48] rounded cursor-pointer"
              />
            </div>
          </section>

          {/* Latest On-Air Segments */}
          <section className="bg-[#121620] border border-white/[0.08] rounded-lg p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-[#F1F5F9]">
                Последние реплики эфира
              </h2>
              <span className="text-xs font-mono tabular-nums text-[#8B95A7]">
                {recentEntries.length} шт.
              </span>
            </div>

            {recentEntries.length === 0 ? (
              <div className="py-8 text-center">
                <AudioWaveform className="w-6 h-6 text-[#475569] mx-auto mb-2" />
                <p className="text-xs text-[#8B95A7]">
                  Реплики появятся здесь сразу после первого перевода.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-white/[0.06]">
                {recentEntries.slice(0, 4).map((entry, idx) => (
                  <li key={entry.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[#8B95A7] mb-1">
                      <span className="font-mono tabular-nums truncate">
                        {formatTimecode(entry.timestamp)} · {entry.voiceName}
                        {entry.translatorLabel ? ` · ${entry.translatorLabel}` : ''} ·{' '}
                        {entry.translateMs + entry.ttsMs} мс
                      </span>
                      <button
                        type="button"
                        onClick={() => onReplayEntry(entry)}
                        aria-label={`Повторить озвучку реплики ${idx + 1}`}
                        className="inline-flex items-center gap-1 text-[#CBD5E1] hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] rounded px-1"
                      >
                        <Play className="w-3 h-3" />
                        <span>Озвучить</span>
                      </button>
                    </div>
                    <p className="text-sm text-[#F8FAFC] leading-snug">
                      {entry.translatedText}
                    </p>
                    <p className="text-xs text-[#64748B] mt-1 line-clamp-1">
                      {entry.originalText}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
