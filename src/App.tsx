import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  FileText,
  Menu,
  Radio,
  Sliders,
  Tv,
  X,
} from 'lucide-react';
import { BroadcastDuckingEngine } from './audio/duckingEngine';
import { ConsoleView } from './components/ConsoleView';
import { ObsOverlayView } from './components/ObsOverlayView';
import { ObsPluginView } from './components/ObsPluginView';
import { TranscriptLogView } from './components/TranscriptLogView';
import {
  DEFAULT_DUCKING_CONFIG,
  DEFAULT_OBS_OVERLAY_CONFIG,
  DEFAULT_OBS_WS_CONFIG,
  INITIAL_DEMO_LOG,
  VOICE_OPTIONS,
} from './constants/presets';
import type {
  AppTab,
  DuckingConfig,
  ObsBroadcastPayload,
  ObsOverlayConfig,
  ObsWebSocketConfig,
  TranscriptEntry,
  TtsModelId,
  VoiceName,
} from './types/translator';
import {
  ObsWebSocketClient,
  type ObsConnectionState,
} from './utils/obsWebSocket';

type LivePipelineMode = 'flash_tts' | 'live_realtime' | 'live_s2s';

function isObsOverlayMode(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('mode') === 'obs' || window.location.pathname === '/obs';
}

export default function App() {
  if (isObsOverlayMode()) {
    return <ObsOverlayView />;
  }

  return <StudioConsoleApp />;
}

function StudioConsoleApp() {
  const [activeTab, setActiveTab] = useState<AppTab>('console');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Core translation & Gemini 3.8 Flash TTS state
  const [sourceLang, setSourceLang] = useState('en');
  const [targetLang, setTargetLang] = useState('ru');
  const [voiceName, setVoiceName] = useState<VoiceName>('Kore');
  const [ttsModel, setTtsModel] = useState<TtsModelId>('gemini-3.8-flash-tts');
  const [voiceStyle, setVoiceStyle] = useState(VOICE_OPTIONS[0].defaultStyle);
  const [livePipelineMode, setLivePipelineMode] =
    useState<LivePipelineMode>('flash_tts');

  // Audio ducking & replacement state
  const [duckingConfig, setDuckingConfig] = useState<DuckingConfig>(
    DEFAULT_DUCKING_CONFIG,
  );
  const [monitorOriginal, setMonitorOriginal] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');

  // Live capture & processing state
  const [isLive, setIsLive] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState('');
  const [errorBanner, setErrorBanner] = useState('');

  // Broadcast history
  const [entries, setEntries] = useState<TranscriptEntry[]>(INITIAL_DEMO_LOG);

  // OBS Plugin state
  const [overlayConfig, setOverlayConfig] = useState<ObsOverlayConfig>(
    DEFAULT_OBS_OVERLAY_CONFIG,
  );
  const [obsWsConfig, setObsWsConfig] = useState<ObsWebSocketConfig>(
    DEFAULT_OBS_WS_CONFIG,
  );
  const [obsWsState, setObsWsState] =
    useState<ObsConnectionState>('disconnected');
  const [obsWsMessage, setObsWsMessage] = useState('');
  const [obsSources, setObsSources] = useState<string[]>([]);
  const [obsClientsCount, setObsClientsCount] = useState(0);

  // Persistent engine & socket refs
  const engineRef = useRef<BroadcastDuckingEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new BroadcastDuckingEngine(DEFAULT_DUCKING_CONFIG);
  }
  const obsWsClientRef = useRef<ObsWebSocketClient | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const obsRelayChannelRef = useRef<BroadcastChannel | null>(null);

  // Keep latest values in refs for WebSocket/audio callbacks
  const latestStateRef = useRef({
    sourceLang,
    targetLang,
    voiceName,
    ttsModel,
    voiceStyle,
    duckingConfig,
    obsWsConfig,
    livePipelineMode,
  });
  latestStateRef.current = {
    sourceLang,
    targetLang,
    voiceName,
    ttsModel,
    voiceStyle,
    duckingConfig,
    obsWsConfig,
    livePipelineMode,
  };

  const broadcastToObsOverlay = useCallback((payload: ObsBroadcastPayload) => {
    obsRelayChannelRef.current?.postMessage(payload);
    void fetch('/api/obs/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((r) => r.json())
      .then((data) => {
        if (typeof data?.clients === 'number') {
          setObsClientsCount(data.clients);
        }
      })
      .catch(() => {
        // Ignore transient overlay relay failures
      });
  }, []);

  // Initialize OBS WebSocket client, BroadcastChannel, audio device enumeration & duck state sync
  useEffect(() => {
    const engine = engineRef.current!;

    if (typeof BroadcastChannel !== 'undefined') {
      obsRelayChannelRef.current = new BroadcastChannel('dubcast-obs-sync');
    }

    obsWsClientRef.current = new ObsWebSocketClient((state, msg) => {
      setObsWsState(state);
      if (msg) setObsWsMessage(msg);
    });

    // When TTS starts/stops speaking, automatically mute or duck the real OBS audio source!
    const unsubDuck = engine.subscribeDuckState(
      ({ isDucking, isOriginalMuted, gainReductionDb }) => {
        broadcastToObsOverlay({
          type: 'duck_state',
          isDucking,
          isOriginalMuted,
          gainReductionDb,
        });

        const wsClient = obsWsClientRef.current;
        const { obsWsConfig: cfg, duckingConfig: dCfg } = latestStateRef.current;
        if (
          wsClient &&
          wsClient.getState() === 'connected' &&
          cfg.autoControlSource &&
          cfg.targetSourceName.trim()
        ) {
          if (dCfg.mode === 'replace_on_speech' || dCfg.mode === 'replace_always') {
            void wsClient.setInputMute(cfg.targetSourceName, isOriginalMuted);
          } else if (dCfg.mode === 'auto_duck') {
            const targetDb = isDucking ? dCfg.duckLevelDb : 0;
            void wsClient.setInputVolumeDb(cfg.targetSourceName, targetDb);
          }
        }
      },
    );

    const refreshDevices = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        setAudioDevices(list.filter((d) => d.kind === 'audioinput'));
      } catch {
        // Ignore permission-restricted enumeration
      }
    };
    void refreshDevices();

    void fetch('/api/health')
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.obsOverlayClients === 'number') {
          setObsClientsCount(d.obsOverlayClients);
        }
      })
      .catch(() => {});

    return () => {
      unsubDuck();
      liveSocketRef.current?.close();
      obsWsClientRef.current?.disconnect();
      obsRelayChannelRef.current?.close();
      engine.dispose();
    };
  }, [broadcastToObsOverlay]);

  // Keep engine synced with ducking config & monitoring toggle
  useEffect(() => {
    engineRef.current?.updateConfig(duckingConfig);
  }, [duckingConfig]);

  useEffect(() => {
    engineRef.current?.setMonitorOriginal(monitorOriginal);
  }, [monitorOriginal]);

  // Push overlay style changes to any open OBS Browser Sources
  const handleOverlayConfigChange = (next: ObsOverlayConfig) => {
    setOverlayConfig(next);
    broadcastToObsOverlay({ type: 'config', config: next });
  };

  /**
   * Core pipeline:
   * 1. Translate text via /api/translate (gemini-4-hydrogen, LOW thinking)
   * 2. Synthesize speech via gemini-3.8-flash-tts (streaming 24kHz PCM or unary WAV)
   * 3. Play through BroadcastDuckingEngine (mutes/ducks original channel automatically)
   * 4. Relay subtitle & audio to OBS Browser Source (/ws/obs)
   */
  const translateAndSpeak = useCallback(
    async (text: string, overrideSourceLang?: string) => {
      const clean = text.trim();
      if (!clean) return;

      const {
        sourceLang: curSrc,
        targetLang: curTgt,
        voiceName: curVoice,
        ttsModel: curModel,
        voiceStyle: curStyle,
        duckingConfig: curDuck,
      } = latestStateRef.current;

      const effectiveSource = overrideSourceLang || curSrc;

      setErrorBanner('');
      setIsProcessing(true);
      setProcessingStage('Перевод реплики (Gemini 3.1 Flash Lite)…');

      try {
        // Step 1: Translate
        const trRes = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: clean,
            sourceLang: effectiveSource,
            targetLang: curTgt,
          }),
        });
        const trData = await trRes.json();
        if (!trRes.ok) {
          throw new Error(trData.error || 'Ошибка перевода речи');
        }

        const translatedText: string = trData.translatedText;
        const translateMs: number = trData.translateMs || 0;

        // Immediately push subtitle to OBS overlay before audio arrives
        broadcastToObsOverlay({
          type: 'subtitle',
          originalText: clean,
          translatedText,
          timestamp: Date.now(),
        });

        setProcessingStage(`Синтез голоса ${curVoice} (${curModel})…`);

        let ttsMs = 0;
        let audioBase64Wav: string | undefined;

        if (curDuck.streamingTts) {
          // Step 2A: Streaming 24kHz PCM from gemini-3.8-flash-tts
          const ttsRes = await fetch('/api/tts/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: translatedText,
              voiceName: curVoice,
              voiceStyle: curStyle,
              ttsModel: curModel,
            }),
          });

          if (!ttsRes.ok || !ttsRes.body) {
            throw new Error('Не удалось запустить поток синтеза речи.');
          }

          const reader = ttsRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const block of lines) {
              const dataLine = block
                .split('\n')
                .find((l) => l.startsWith('data: '));
              if (!dataLine) continue;
              const event = JSON.parse(dataLine.slice(6));
              if (event.type === 'pcm' && event.data) {
                engineRef.current?.enqueuePcm24kBase64(event.data);
              } else if (event.type === 'done') {
                ttsMs = event.ttsMs || 0;
              } else if (event.type === 'error') {
                throw new Error(event.error || 'Ошибка потокового TTS');
              }
            }
          }
        } else {
          // Step 2B: Unary WAV from gemini-3.8-flash-tts (also streams full WAV to OBS Browser Source)
          const ttsRes = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: translatedText,
              voiceName: curVoice,
              voiceStyle: curStyle,
              ttsModel: curModel,
            }),
          });
          const ttsData = await ttsRes.json();
          if (!ttsRes.ok) {
            throw new Error(ttsData.error || 'Ошибка синтеза речи');
          }
          audioBase64Wav = ttsData.audioBase64Wav;
          ttsMs = ttsData.ttsMs || 0;

          if (audioBase64Wav) {
            broadcastToObsOverlay({
              type: 'audio_wav',
              originalText: clean,
              translatedText,
              audioBase64Wav,
              timestamp: Date.now(),
            });
            void engineRef.current?.playWavBase64(audioBase64Wav);
          }
        }

        const newEntry: TranscriptEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
          sourceLang: effectiveSource,
          targetLang: curTgt,
          originalText: clean,
          translatedText,
          voiceName: curVoice,
          ttsModel: curModel,
          voiceStyle: curStyle,
          translateMs,
          ttsMs,
          audioBase64Wav,
        };

        setEntries((prev) => [newEntry, ...prev]);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Не удалось выполнить перевод';
        setErrorBanner(msg);
      } finally {
        setIsProcessing(false);
        setProcessingStage('');
      }
    },
    [broadcastToObsOverlay],
  );

  // Start / Stop live real-time microphone capture & server-to-server WebSocket bridge
  const stopLiveSession = useCallback(() => {
    engineRef.current?.stopMicCapture();
    if (liveSocketRef.current) {
      try {
        liveSocketRef.current.close();
      } catch {
        // Ignore
      }
      liveSocketRef.current = null;
    }
    setIsLive(false);
    setInterimTranscript('');
  }, []);

  const startLiveSession = useCallback(async () => {
    setErrorBanner('');
    try {
      const {
        sourceLang: curSrc,
        targetLang: curTgt,
        voiceName: curVoice,
        livePipelineMode: curPipeline,
      } = latestStateRef.current;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsPath =
        curPipeline === 'live_realtime'
          ? `/ws/live-translate?target=${encodeURIComponent(curTgt)}&engine=realtime&voice=${encodeURIComponent(curVoice)}`
          : curPipeline === 'live_s2s'
            ? `/ws/live-translate?target=${encodeURIComponent(curTgt)}&engine=translate`
            : `/ws/transcribe?lang=${encodeURIComponent(curSrc)}`;

      const ws = new WebSocket(`${proto}//${window.location.host}${wsPath}`);
      liveSocketRef.current = ws;

      let s2sInputAccum = '';
      let s2sOutputAccum = '';

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.type === 'error') {
            setErrorBanner(msg.message || 'Ошибка потокового соединения Gemini Live');
            stopLiveSession();
            return;
          }
          if (msg.type === 'interrupted') {
            engineRef.current?.stopAllTts();
            return;
          }
          if (msg.type === 'interim' && msg.text) {
            setInterimTranscript(msg.text);
          }
          if (msg.type === 'final' && msg.text) {
            const finalSentence = String(msg.text).trim();
            setInterimTranscript('');
            if (finalSentence.length > 1) {
              void translateAndSpeak(finalSentence);
            }
          }
          // Live Speech-to-Speech mode direct audio & transcripts
          if (msg.type === 'inputTranscript' && msg.text) {
            s2sInputAccum += msg.text;
            setInterimTranscript(s2sInputAccum.slice(-140));
          }
          if (msg.type === 'outputTranscript' && msg.text) {
            s2sOutputAccum += msg.text;
            broadcastToObsOverlay({
              type: 'subtitle',
              originalText: s2sInputAccum.trim(),
              translatedText: s2sOutputAccum.trim(),
              timestamp: Date.now(),
            });
          }
          if (msg.type === 'audio' && msg.data) {
            engineRef.current?.enqueuePcm24kBase64(msg.data);
          }
        } catch {
          // Ignore malformed ws messages
        }
      };

      ws.onerror = () => {
        setErrorBanner('Потеряно WebSocket-соединение с сервером распознавания.');
      };

      ws.onclose = () => {
        if (liveSocketRef.current === ws) {
          liveSocketRef.current = null;
        }
      };

      await engineRef.current?.startMicCapture(
        selectedDeviceId || undefined,
        (base64Pcm16k) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'audio', data: base64Pcm16k }));
          }
        },
      );

      setIsLive(true);
    } catch (err) {
      stopLiveSession();
      const msg =
        err instanceof Error
          ? err.message
          : 'Нет доступа к микрофону. Разрешите использование аудиовхода в браузере.';
      setErrorBanner(msg);
    }
  }, [broadcastToObsOverlay, selectedDeviceId, stopLiveSession, translateAndSpeak]);

  const handleToggleLive = () => {
    if (isLive) {
      stopLiveSession();
    } else {
      void startLiveSession();
    }
  };

  // Upload an audio clip: play original through ducking bus while transcribing + dubbing
  const handleUploadAudioClip = async (file: File) => {
    setErrorBanner('');
    setIsProcessing(true);
    setProcessingStage(`Расшифровка файла «${file.name}» (Gemini 3.5 Transcribe)…`);

    try {
      const arrayBuf = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const audioBase64 = btoa(binary);

      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64,
          mimeType: file.type || 'audio/wav',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Не удалось расшифровать аудиофайл');
      }
      const transcript = (data.transcript || '').trim();
      if (!transcript) {
        throw new Error('В загруженном аудиофайле не обнаружена речь.');
      }

      // Play original clip through the ducking processor so user hears it get muted/replaced!
      void engineRef.current?.playOriginalClipBuffer(arrayBuf).catch(() => {});
      await translateAndSpeak(transcript);
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Ошибка обработки аудиофайла',
      );
      setIsProcessing(false);
      setProcessingStage('');
    }
  };

  // Replay an existing log entry via cached WAV or fresh gemini-3.8-flash-tts call
  const handleReplayEntry = async (entry: TranscriptEntry) => {
    setErrorBanner('');
    broadcastToObsOverlay({
      type: 'subtitle',
      originalText: entry.originalText,
      translatedText: entry.translatedText,
      timestamp: Date.now(),
    });

    if (entry.audioBase64Wav) {
      broadcastToObsOverlay({
        type: 'audio_wav',
        originalText: entry.originalText,
        translatedText: entry.translatedText,
        audioBase64Wav: entry.audioBase64Wav,
        timestamp: Date.now(),
      });
      await engineRef.current?.playWavBase64(entry.audioBase64Wav);
      return;
    }

    setIsProcessing(true);
    setProcessingStage(`Озвучка через ${ttsModel} (${voiceName})…`);
    try {
      const ttsRes = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: entry.translatedText,
          voiceName,
          voiceStyle,
          ttsModel,
        }),
      });
      const data = await ttsRes.json();
      if (!ttsRes.ok) {
        throw new Error(data.error || 'Ошибка озвучки');
      }
      if (data.audioBase64Wav) {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entry.id
              ? { ...e, audioBase64Wav: data.audioBase64Wav }
              : e,
          ),
        );
        broadcastToObsOverlay({
          type: 'audio_wav',
          originalText: entry.originalText,
          translatedText: entry.translatedText,
          audioBase64Wav: data.audioBase64Wav,
          timestamp: Date.now(),
        });
        await engineRef.current?.playWavBase64(data.audioBase64Wav);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Ошибка озвучки');
    } finally {
      setIsProcessing(false);
      setProcessingStage('');
    }
  };

  // OBS WebSocket v5 Connect / Test
  const handleConnectObsWs = async () => {
    try {
      const sources = await obsWsClientRef.current!.connect(
        obsWsConfig.host.trim(),
        obsWsConfig.port,
        obsWsConfig.password,
      );
      setObsSources(sources);
      if (sources.length > 0 && !sources.includes(obsWsConfig.targetSourceName)) {
        setObsWsConfig((prev) => ({ ...prev, targetSourceName: sources[0] }));
      }
    } catch {
      // Error state handled by callback
    }
  };

  const handleTestObsMute = async () => {
    const client = obsWsClientRef.current;
    if (!client || client.getState() !== 'connected') return;
    try {
      await client.setInputMute(obsWsConfig.targetSourceName, true);
      setObsWsMessage(
        `Источник «${obsWsConfig.targetSourceName}» заглушён на 2 секунды…`,
      );
      window.setTimeout(() => {
        void client.setInputMute(obsWsConfig.targetSourceName, false).then(() => {
          setObsWsMessage(
            `Источник «${obsWsConfig.targetSourceName}» успешно восстановлен.`,
          );
        });
      }, 2000);
    } catch (err) {
      setObsWsMessage(
        err instanceof Error
          ? err.message
          : 'Не удалось управлять источником в OBS.',
      );
    }
  };

  const tabMeta: Record<AppTab, string> = {
    console: 'Пульт перевода',
    obs: 'Плагин OBS Studio',
    log: 'Журнал эфира',
  };

  const navItems: { id: AppTab; label: string; icon: typeof Sliders }[] = [
    { id: 'console', label: 'Пульт перевода', icon: Sliders },
    { id: 'obs', label: 'Плагин OBS', icon: Tv },
    { id: 'log', label: 'Журнал эфира', icon: FileText },
  ];

  const renderPipelineSwitcher = () => (
    <div className="p-3.5 border-t border-white/[0.07] space-y-2 shrink-0">
      <div className="text-[11px] font-medium text-[#8B95A7]">
        Тракт реального времени (Server-to-Server)
      </div>
      <div className="grid grid-cols-1 gap-1.5">
        <button
          type="button"
          aria-pressed={livePipelineMode === 'flash_tts'}
          onClick={() => {
            if (isLive) stopLiveSession();
            setLivePipelineMode('flash_tts');
          }}
          className={`px-2.5 py-1.5 rounded text-left text-xs border transition-colors ${
            livePipelineMode === 'flash_tts'
              ? 'bg-[#1A202E] border-[#E11D48] text-white'
              : 'bg-[#0B0E14] border-white/[0.06] text-[#8B95A7] hover:text-white'
          }`}
        >
          <div className="font-medium leading-tight">Gemini 3.8 Flash TTS</div>
          <div className="text-[11px] text-[#64748B] leading-tight mt-0.5">
            Дикторская озвучка + Voice Design
          </div>
        </button>
        <button
          type="button"
          aria-pressed={livePipelineMode === 'live_realtime'}
          onClick={() => {
            if (isLive) stopLiveSession();
            setLivePipelineMode('live_realtime');
          }}
          className={`px-2.5 py-1.5 rounded text-left text-xs border transition-colors ${
            livePipelineMode === 'live_realtime'
              ? 'bg-[#1A202E] border-[#E11D48] text-white'
              : 'bg-[#0B0E14] border-white/[0.06] text-[#8B95A7] hover:text-white'
          }`}
        >
          <div className="font-medium leading-tight">Gemini 3.8 Live Realtime</div>
          <div className="text-[11px] text-[#64748B] leading-tight mt-0.5">
            Нативный голос Live API + выбор диктора
          </div>
        </button>
        <button
          type="button"
          aria-pressed={livePipelineMode === 'live_s2s'}
          onClick={() => {
            if (isLive) stopLiveSession();
            setLivePipelineMode('live_s2s');
          }}
          className={`px-2.5 py-1.5 rounded text-left text-xs border transition-colors ${
            livePipelineMode === 'live_s2s'
              ? 'bg-[#1A202E] border-[#E11D48] text-white'
              : 'bg-[#0B0E14] border-white/[0.06] text-[#8B95A7] hover:text-white'
          }`}
        >
          <div className="font-medium leading-tight">Live Translate S2S</div>
          <div className="text-[11px] text-[#64748B] leading-tight mt-0.5">
            Прямой синхронный переводчик (70+ яз.)
          </div>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0B0E14] text-[#E6ECF5] flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-60 shrink-0 sticky top-0 h-screen overflow-y-auto bg-[#0E121B] border-r border-white/[0.07]">
        <div className="h-16 px-5 flex items-center border-b border-white/[0.07] shrink-0">
          <span className="font-display font-bold text-base tracking-tight text-white whitespace-nowrap">
            DubCast OBS
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1" aria-label="Основная навигация">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                  active
                    ? 'bg-[#1A202E] text-white'
                    : 'text-[#8B95A7] hover:text-[#E6ECF5] hover:bg-white/[0.03]'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {renderPipelineSwitcher()}
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/60"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="relative w-64 max-w-[82vw] bg-[#0E121B] border-r border-white/[0.08] flex flex-col z-10 h-full overflow-y-auto">
            <div className="h-14 px-4 flex items-center justify-between border-b border-white/[0.07] shrink-0">
              <span className="font-display font-bold text-base text-white">
                DubCast OBS
              </span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Закрыть меню"
                className="p-1.5 text-[#94A3B8] hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium ${
                      active
                        ? 'bg-[#1A202E] text-white'
                        : 'text-[#8B95A7] hover:text-white'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            {renderPipelineSwitcher()}
          </div>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Strict Single-Row Top Bar: Breadcrumb left — Primary Action right */}
        <header className="h-16 px-4 sm:px-6 border-b border-white/[0.07] bg-[#0B0E14] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Открыть навигацию"
              className="lg:hidden p-2 -ml-2 text-[#94A3B8] hover:text-white rounded-md shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="hidden sm:inline lg:hidden font-display font-bold text-white whitespace-nowrap">
                DubCast OBS
              </span>
              <span
                className="hidden sm:inline lg:hidden text-[#475569]"
                aria-hidden="true"
              >
                /
              </span>
              <h1 className="font-display font-semibold text-[#F1F5F9] truncate">
                {tabMeta[activeTab]}
              </h1>
            </div>
          </div>

          <button
            type="button"
            onClick={handleToggleLive}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
              isLive
                ? 'bg-[#1C2230] text-[#FB7185] border border-[#E11D48]/60 hover:bg-[#252D40]'
                : 'bg-[#E11D48] text-white hover:bg-[#BE123C]'
            }`}
          >
            <Radio className="w-3.5 h-3.5 shrink-0" />
            <span>{isLive ? 'Остановить эфир' : 'Начать эфир'}</span>
          </button>
        </header>

        {/* Main Scroll Viewport */}
        <main className="flex-1 p-4 sm:p-6 max-w-[1360px] w-full mx-auto space-y-5">
          {errorBanner && (
            <div
              role="alert"
              className="bg-[#2A1219] border border-[#E11D48]/50 rounded-lg px-4 py-3 flex items-start justify-between gap-3 text-xs text-[#FECDD3]"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-[#FB7185] shrink-0 mt-0.5" />
                <span>{errorBanner}</span>
              </div>
              <button
                type="button"
                onClick={() => setErrorBanner('')}
                aria-label="Скрыть уведомление об ошибке"
                className="text-[#FDA4AF] hover:text-white shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {activeTab === 'console' && (
            <ConsoleView
              engine={engineRef.current!}
              isLive={isLive}
              onToggleLive={handleToggleLive}
              sourceLang={sourceLang}
              targetLang={targetLang}
              onChangeSourceLang={setSourceLang}
              onChangeTargetLang={setTargetLang}
              voiceName={voiceName}
              onChangeVoiceName={(v) => {
                setVoiceName(v);
                const meta = VOICE_OPTIONS.find((o) => o.id === v);
                if (meta) setVoiceStyle(meta.defaultStyle);
              }}
              ttsModel={ttsModel}
              onChangeTtsModel={setTtsModel}
              voiceStyle={voiceStyle}
              onChangeVoiceStyle={setVoiceStyle}
              duckingConfig={duckingConfig}
              onChangeDuckingConfig={setDuckingConfig}
              audioDevices={audioDevices}
              selectedDeviceId={selectedDeviceId}
              onChangeDeviceId={setSelectedDeviceId}
              monitorOriginal={monitorOriginal}
              onToggleMonitorOriginal={setMonitorOriginal}
              interimTranscript={interimTranscript}
              isProcessing={isProcessing}
              processingStage={processingStage}
              onTranslateAndSpeak={translateAndSpeak}
              onUploadAudioClip={handleUploadAudioClip}
              recentEntries={entries}
              onReplayEntry={(e) => void handleReplayEntry(e)}
              onStopAudio={() => {
                engineRef.current?.stopAllTts();
                engineRef.current?.stopOriginalClip();
              }}
            />
          )}

          {activeTab === 'obs' && (
            <ObsPluginView
              overlayConfig={overlayConfig}
              onChangeOverlayConfig={handleOverlayConfigChange}
              wsConfig={obsWsConfig}
              onChangeWsConfig={setObsWsConfig}
              wsState={obsWsState}
              wsMessage={obsWsMessage}
              obsSources={obsSources}
              onConnectObsWs={handleConnectObsWs}
              onDisconnectObsWs={() => obsWsClientRef.current?.disconnect()}
              onTestObsMute={handleTestObsMute}
              duckingConfig={duckingConfig}
              latestOriginal={entries[0]?.originalText || ''}
              latestTranslated={entries[0]?.translatedText || ''}
              obsClientsCount={obsClientsCount}
            />
          )}

          {activeTab === 'log' && (
            <TranscriptLogView
              entries={entries}
              onReplayEntry={(e) => void handleReplayEntry(e)}
              onClearEntries={() => setEntries([])}
              onJumpToConsole={() => setActiveTab('console')}
            />
          )}
        </main>
      </div>
    </div>
  );
}
