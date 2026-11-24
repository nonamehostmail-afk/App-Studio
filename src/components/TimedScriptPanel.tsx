import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Clock,
  Download,
  FileText,
  Pause,
  Play,
  SkipForward,
  Square,
  Upload,
} from 'lucide-react';
import type { TtsModelId, VoiceName } from '../types/translator';
import {
  formatCueTime,
  mergeTimedWavClipsToMasterWav,
  parseTimedScript,
  SAMPLE_TIMED_SCRIPT,
  triggerWavDownload,
  type TimedCue,
} from '../utils/timedScript';

export interface TimedCueSynthResult {
  originalText: string;
  spokenText: string;
  audioBase64Wav: string;
  translateMs: number;
  ttsMs: number;
  translatorLabel?: string;
}

interface TimedScriptPanelProps {
  onSynthesizeCue: (
    cleanText: string,
    shouldTranslate: boolean,
  ) => Promise<TimedCueSynthResult>;
  onPlayTimedCue: (cue: TimedCue, synth: TimedCueSynthResult) => void;
  onStopAudio: () => void;
  voiceName: VoiceName;
  ttsModel: TtsModelId;
  voiceStyle: string;
  targetLang: string;
}

type PlaybackStatus = 'idle' | 'preparing' | 'playing' | 'paused';

export function TimedScriptPanel({
  onSynthesizeCue,
  onPlayTimedCue,
  onStopAudio,
  voiceName,
  ttsModel,
  voiceStyle,
  targetLang,
}: TimedScriptPanelProps) {
  const [rawText, setRawText] = useState('');
  const [shouldTranslate, setShouldTranslate] = useState(false);
  const [status, setStatus] = useState<PlaybackStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [activeCueId, setActiveCueId] = useState<string | null>(null);
  const [spokenCueIds, setSpokenCueIds] = useState<Set<string>>(() => new Set());
  const [prepProgress, setPrepProgress] = useState('');
  const [panelError, setPanelError] = useState('');
  const [isExportingWav, setIsExportingWav] = useState(false);
  const [cacheVersion, setCacheVersion] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const synthCacheRef = useRef<Map<string, TimedCueSynthResult>>(new Map());
  const timerRef = useRef<number | null>(null);
  const abortRunRef = useRef(0);
  const anchorPerfRef = useRef(0);
  const anchorElapsedRef = useRef(0);
  const firedCueIdsRef = useRef<Set<string>>(new Set());

  const cues = useMemo(() => parseTimedScript(rawText), [rawText]);

  const makeCacheKey = (cleanText: string) =>
    `${cleanText}__${shouldTranslate ? 'tr' : 'raw'}__${voiceName}__${ttsModel}__${voiceStyle}__${targetLang}`;

  const lastCueStartMs = cues.length > 0 ? cues[cues.length - 1].startMs : 0;

  const stopTimerOnly = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleStop = () => {
    abortRunRef.current += 1;
    stopTimerOnly();
    onStopAudio();
    setStatus('idle');
    setElapsedMs(0);
    setActiveCueId(null);
    setPrepProgress('');
    firedCueIdsRef.current = new Set();
    setSpokenCueIds(new Set());
  };

  useEffect(() => {
    return () => {
      abortRunRef.current += 1;
      stopTimerOnly();
    };
  }, []);

  // Ensure all required cues are synthesized before playback/export so start timestamps stay exact
  const ensureCuesSynthesized = async (
    targetCues: TimedCue[],
    runId: number,
  ): Promise<boolean> => {
    const missing = targetCues.filter(
      (c) => !synthCacheRef.current.has(makeCacheKey(c.cleanText)),
    );
    if (missing.length === 0) return true;

    for (let i = 0; i < missing.length; i++) {
      if (abortRunRef.current !== runId) return false;
      const cue = missing[i];
      setPrepProgress(
        `Подготовка озвучки ${i + 1} / ${missing.length} (${cue.timeLabel})…`,
      );
      const res = await onSynthesizeCue(cue.cleanText, shouldTranslate);
      if (abortRunRef.current !== runId) return false;
      synthCacheRef.current.set(makeCacheKey(cue.cleanText), res);
      setCacheVersion((v) => v + 1);
    }
    setPrepProgress('');
    return true;
  };

  const startClockLoop = (
    activeCues: TimedCue[],
    startFromMs: number,
    runId: number,
  ) => {
    stopTimerOnly();
    anchorPerfRef.current = performance.now();
    anchorElapsedRef.current = startFromMs;
    setElapsedMs(startFromMs);
    setStatus('playing');

    const tick = () => {
      if (abortRunRef.current !== runId) {
        stopTimerOnly();
        return;
      }
      const nowElapsed =
        anchorElapsedRef.current + (performance.now() - anchorPerfRef.current);
      setElapsedMs(nowElapsed);

      for (const cue of activeCues) {
        if (
          nowElapsed >= cue.startMs &&
          !firedCueIdsRef.current.has(cue.id)
        ) {
          firedCueIdsRef.current.add(cue.id);
          setActiveCueId(cue.id);
          setSpokenCueIds(new Set(firedCueIdsRef.current));

          const cached = synthCacheRef.current.get(makeCacheKey(cue.cleanText));
          if (cached) {
            onPlayTimedCue(cue, cached);
          }
        }
      }

      // Stop master clock gently 1.5s after the last cue has been triggered
      const allFired = activeCues.every((c) => firedCueIdsRef.current.has(c.id));
      if (allFired && nowElapsed > lastCueStartMs + 1500) {
        stopTimerOnly();
        setStatus('idle');
      }
    };

    // Trigger immediately in case cue starts at 00:00 or startFromMs matches cue.startMs
    tick();
    timerRef.current = window.setInterval(tick, 40);
  };

  const handleStartFromMs = async (startFromMs: number) => {
    setPanelError('');
    if (cues.length === 0) {
      setPanelError(
        'Добавьте текст с таймингами (например: [00:02] Текст реплики или SRT-субтитры).',
      );
      return;
    }

    const upcoming = cues.filter((c) => c.startMs >= startFromMs);
    if (upcoming.length === 0) {
      setPanelError('После выбранного тайминга нет реплик.');
      return;
    }

    abortRunRef.current += 1;
    const runId = abortRunRef.current;
    stopTimerOnly();
    onStopAudio();

    // Mark earlier cues before startFromMs as already passed so they don't fire retroactively
    const preFired = new Set<string>();
    for (const c of cues) {
      if (c.startMs < startFromMs) preFired.add(c.id);
    }
    firedCueIdsRef.current = preFired;
    setSpokenCueIds(new Set(preFired));
    setActiveCueId(null);

    setStatus('preparing');
    try {
      const ok = await ensureCuesSynthesized(upcoming, runId);
      if (!ok || abortRunRef.current !== runId) return;
      startClockLoop(cues, startFromMs, runId);
    } catch (err) {
      if (abortRunRef.current !== runId) return;
      setStatus('idle');
      setPrepProgress('');
      setPanelError(
        err instanceof Error
          ? err.message
          : 'Не удалось подготовить озвучку по таймингам.',
      );
    }
  };

  const handlePlayOrPause = () => {
    if (status === 'playing') {
      stopTimerOnly();
      const pausedAt =
        anchorElapsedRef.current + (performance.now() - anchorPerfRef.current);
      anchorElapsedRef.current = pausedAt;
      setElapsedMs(pausedAt);
      onStopAudio();
      setStatus('paused');
      return;
    }

    if (status === 'paused') {
      const runId = abortRunRef.current;
      startClockLoop(cues, anchorElapsedRef.current, runId);
      return;
    }

    void handleStartFromMs(0);
  };

  const handleDownloadMasterWav = async () => {
    setPanelError('');
    if (cues.length === 0) {
      setPanelError('Нет распознанных реплик с таймингами для сборки WAV.');
      return;
    }

    abortRunRef.current += 1;
    const runId = abortRunRef.current;
    setIsExportingWav(true);
    try {
      const ok = await ensureCuesSynthesized(cues, runId);
      if (!ok) return;

      const clips = cues
        .map((cue) => {
          const synth = synthCacheRef.current.get(makeCacheKey(cue.cleanText));
          return synth?.audioBase64Wav
            ? { startMs: cue.startMs, wavBase64: synth.audioBase64Wav }
            : null;
        })
        .filter((x): x is { startMs: number; wavBase64: string } => x !== null);

      const masterWav = mergeTimedWavClipsToMasterWav(clips, 24000);
      if (!masterWav) {
        throw new Error('Не удалось собрать общую аудиодорожку WAV.');
      }
      triggerWavDownload(masterWav, `dubcast_timed_${voiceName.toLowerCase()}.wav`);
    } catch (err) {
      setPanelError(
        err instanceof Error ? err.message : 'Ошибка сборки WAV-файла.',
      );
    } finally {
      setIsExportingWav(false);
      setPrepProgress('');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const text = await file.text();
      handleStop();
      setRawText(text);
      setPanelError('');
    } catch {
      setPanelError('Не удалось прочитать текстовый файл.');
    }
  };

  // Used to ensure cached badges refresh when synthesis cache updates
  const cachedCount = useMemo(() => {
    void cacheVersion;
    return cues.filter((c) => synthCacheRef.current.has(makeCacheKey(c.cleanText)))
      .length;
  }, [cues, cacheVersion, shouldTranslate, voiceName, ttsModel, voiceStyle, targetLang]);

  return (
    <div className="space-y-4">
      {/* Top action bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              handleStop();
              setRawText(SAMPLE_TIMED_SCRIPT);
              setPanelError('');
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs text-[#CBD5E1] bg-[#1C2230] hover:bg-[#252D40] border border-white/[0.08] transition-colors whitespace-nowrap"
          >
            <FileText className="w-3.5 h-3.5" />
            Вставить пример
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".srt,.vtt,.txt"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs text-[#CBD5E1] bg-[#1C2230] hover:bg-[#252D40] border border-white/[0.08] transition-colors whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5" />
            Загрузить .SRT / .TXT
          </button>

          {rawText.trim().length > 0 && (
            <button
              type="button"
              onClick={() => {
                handleStop();
                setRawText('');
                setPanelError('');
              }}
              className="px-2.5 py-1.5 rounded text-xs text-[#94A3B8] hover:text-white transition-colors whitespace-nowrap"
            >
              Очистить
            </button>
          )}
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-[#CBD5E1] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={shouldTranslate}
            onChange={(e) => setShouldTranslate(e.target.checked)}
            className="w-3.5 h-3.5 accent-[#E11D48] cursor-pointer"
          />
          <span>Переводить перед озвучкой</span>
        </label>
      </div>

      {/* Script Input Textarea */}
      <div>
        <label htmlFor="timed-script-textarea" className="sr-only">
          Текст с таймингами для синхронной озвучки
        </label>
        <textarea
          id="timed-script-textarea"
          rows={5}
          value={rawText}
          onChange={(e) => {
            setRawText(e.target.value);
            if (panelError) setPanelError('');
          }}
          placeholder={`Вставьте текст с таймингами или субтитры SRT / VTT. Сами тайминги в речь не озвучиваются:\n[00:01] Добро пожаловать в эфир!\n[00:07] Вторая реплика начнётся ровно на седьмой секунде.\n00:00:14,000 --> 00:00:19,000\nПоддерживаются форматы [MM:SS], MM:SS - и SRT.`}
          className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3.5 py-2.5 text-xs font-mono leading-relaxed text-[#F1F5F9] placeholder:text-[#64748B] focus:outline-none focus:border-[#E11D48] resize-y"
        />
      </div>

      {panelError && (
        <p role="alert" className="text-xs text-[#FB7185]">
          {panelError}
        </p>
      )}

      {/* Master Clock & Transport Controls */}
      <div className="bg-[#0B0E14] border border-white/[0.08] rounded-md p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 whitespace-nowrap shrink-0">
            <Clock
              className={`w-4 h-4 shrink-0 ${
                status === 'playing' ? 'text-[#E11D48]' : 'text-[#64748B]'
              }`}
            />
            <span
              data-testid="timed-master-clock"
              className="font-mono tabular-nums text-base font-semibold text-white whitespace-nowrap"
            >
              {formatCueTime(elapsedMs, true)}
            </span>
            <span className="font-mono tabular-nums text-xs text-[#64748B] whitespace-nowrap">
              / {formatCueTime(lastCueStartMs)}
            </span>
          </div>

          {prepProgress && (
            <span className="text-xs text-[#38BDF8] truncate">
              {prepProgress}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handlePlayOrPause}
            disabled={
              cues.length === 0 || status === 'preparing' || isExportingWav
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-semibold bg-[#E11D48] hover:bg-[#BE123C] text-white transition-colors whitespace-nowrap disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            {status === 'playing' ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                Пауза
              </>
            ) : status === 'paused' ? (
              <>
                <Play className="w-3.5 h-3.5" />
                Продолжить
              </>
            ) : status === 'preparing' ? (
              <>
                <Play className="w-3.5 h-3.5" />
                Подготовка…
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                Запустить по таймингам
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleStop}
            disabled={status === 'idle' && elapsedMs === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08] transition-colors whitespace-nowrap disabled:opacity-40"
          >
            <Square className="w-3 h-3" />
            Стоп
          </button>

          <button
            type="button"
            onClick={() => void handleDownloadMasterWav()}
            disabled={
              cues.length === 0 || status === 'preparing' || isExportingWav
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08] transition-colors whitespace-nowrap disabled:opacity-40"
          >
            <Download className="w-3.5 h-3.5" />
            {isExportingWav ? 'Сборка WAV…' : 'Скачать дорожку .WAV'}
          </button>
        </div>
      </div>

      {/* Parsed Timeline Preview */}
      {cues.length > 0 && (
        <div className="border border-white/[0.08] rounded-md bg-[#0B0E14] overflow-hidden">
          <div className="px-3.5 py-2 border-b border-white/[0.06] flex items-center justify-between gap-2 text-[11px] text-[#8B95A7]">
            <span>
              Распознано строк:{' '}
              <span className="font-mono tabular-nums text-[#E6ECF5]">
                {cues.length}
              </span>{' '}
              · тайминги удалены из озвучиваемого текста
            </span>
            <span className="font-mono tabular-nums text-[#64748B]">
              В кэше WAV: {cachedCount}/{cues.length}
            </span>
          </div>

          <ul
            data-testid="timed-cues-list"
            className="divide-y divide-white/[0.06] max-h-60 overflow-y-auto"
          >
            {cues.map((cue) => {
              const isActive = activeCueId === cue.id;
              const isSpoken = spokenCueIds.has(cue.id);
              const isCached = synthCacheRef.current.has(
                makeCacheKey(cue.cleanText),
              );

              return (
                <li
                  key={cue.id}
                  className={`px-3.5 py-2.5 flex items-start justify-between gap-3 text-xs transition-colors ${
                    isActive ? 'bg-[#1D1622]' : 'hover:bg-white/[0.02]'
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <span
                      className={`font-mono tabular-nums shrink-0 mt-0.5 ${
                        isActive
                          ? 'text-[#FB7185] font-semibold'
                          : isSpoken
                            ? 'text-[#34D399]'
                            : 'text-[#38BDF8]'
                      }`}
                    >
                      {cue.timeLabel}
                    </span>
                    <span
                      className={`leading-relaxed break-words ${
                        isActive
                          ? 'text-white font-medium'
                          : isSpoken
                            ? 'text-[#94A3B8]'
                            : 'text-[#E6ECF5]'
                      }`}
                    >
                      {cue.cleanText}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] font-mono text-[#64748B] whitespace-nowrap">
                      {isActive
                        ? 'В эфире'
                        : isSpoken
                          ? 'Озвучено'
                          : isCached
                            ? 'WAV готов'
                            : 'Ожидание'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleStartFromMs(cue.startMs)}
                      disabled={status === 'preparing' || isExportingWav}
                      title={`Запустить с ${cue.timeLabel}`}
                      aria-label={`Запустить с тайминга ${cue.timeLabel}`}
                      className="p-1 rounded text-[#94A3B8] hover:text-white hover:bg-white/[0.06] disabled:opacity-40 transition-colors"
                    >
                      <SkipForward className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
