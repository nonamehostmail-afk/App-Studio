import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  FileText,
  Menu,
  Radio,
  Sliders,
  Tv,
  X,
} from 'lucide-react';
import { BroadcastDuckingEngine } from './audio/duckingEngine';
import { CameraStudioView } from './components/CameraStudioView';
import { ConsoleView } from './components/ConsoleView';
import { ObsOverlayView } from './components/ObsOverlayView';
import { ObsPluginView } from './components/ObsPluginView';
import { TranscriptLogView } from './components/TranscriptLogView';
import {
  DEFAULT_CAMERA_CONFIG,
  DEFAULT_DUCKING_CONFIG,
  DEFAULT_LOCAL_MODEL_CONFIG,
  DEFAULT_OBS_OVERLAY_CONFIG,
  DEFAULT_OBS_WS_CONFIG,
  INITIAL_DEMO_LOG,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
  VOICE_OPTIONS,
} from './constants/presets';
import type {
  AppTab,
  CameraConfig,
  DuckingConfig,
  LocalModelConfig,
  ObsBroadcastPayload,
  ObsOverlayConfig,
  ObsWebSocketConfig,
  TranscriptEntry,
  TtsModelId,
  VoiceName,
} from './types/translator';
import {
  buildLocalChatEndpoint,
  buildLocalModelsEndpoint,
  buildLocalTranslateRequest,
  extractLocalTranslationText,
  parseLocalModelList,
} from './utils/localModel';
import {
  ObsWebSocketClient,
  type ObsConnectionState,
} from './utils/obsWebSocket';
import { formatTimecode } from './utils/duckingMath';
import {
  pcmChunksToWavBase64,
  triggerWavDownload,
  type TimedCue,
} from './utils/timedScript';
import type { TimedCueSynthResult } from './components/TimedScriptPanel';

type LivePipelineMode = 'flash_tts' | 'live_realtime' | 'live_s2s';

function isObsOverlayMode(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('mode') === 'obs' || window.location.pathname === '/obs';
}

function getLangDisplayName(code: string): string {
  const found =
    SOURCE_LANGUAGES.find((l) => l.code === code) ||
    TARGET_LANGUAGES.find((l) => l.code === code);
  return found?.nativeName || code;
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

  // Local Translation LLM state (Ollama / LM Studio / llama.cpp)
  const [localModelConfig, setLocalModelConfig] = useState<LocalModelConfig>(
    DEFAULT_LOCAL_MODEL_CONFIG,
  );
  const [discoveredLocalModels, setDiscoveredLocalModels] = useState<string[]>(
    [],
  );
  const [localModelStatus, setLocalModelStatus] = useState<{
    state: 'idle' | 'loading' | 'ok' | 'error';
    message: string;
  }>({ state: 'idle', message: '' });

  // Studio Camera & Vision state
  const [cameraConfig, setCameraConfig] = useState<CameraConfig>(
    DEFAULT_CAMERA_CONFIG,
  );
  const [cameraActive, setCameraActive] = useState(false);

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
  const [downloadingEntryId, setDownloadingEntryId] = useState<string | null>(
    null,
  );

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
  const obsRelayWsRef = useRef<WebSocket | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const obsRelayChannelRef = useRef<BroadcastChannel | null>(null);
  const latestCameraFrameRef = useRef<string>('');
  const bridgeConnectTimeoutRef = useRef<number | null>(null);

  // Keep latest values in refs for WebSocket/audio callbacks
  const latestStateRef = useRef({
    sourceLang,
    targetLang,
    voiceName,
    ttsModel,
    voiceStyle,
    duckingConfig,
    obsWsConfig,
    obsWsState,
    livePipelineMode,
    localModelConfig,
    cameraConfig,
    cameraActive,
  });
  latestStateRef.current = {
    sourceLang,
    targetLang,
    voiceName,
    ttsModel,
    voiceStyle,
    duckingConfig,
    obsWsConfig,
    obsWsState,
    livePipelineMode,
    localModelConfig,
    cameraConfig,
    cameraActive,
  };

  const broadcastToObsOverlay = useCallback(
    (payload: ObsBroadcastPayload, wsOnly = false) => {
      try {
        obsRelayChannelRef.current?.postMessage(payload);
      } catch {
        // Ignore BroadcastChannel errors
      }

      const relayWs = obsRelayWsRef.current;
      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        try {
          relayWs.send(JSON.stringify(payload));
          if (wsOnly) return;
        } catch {
          // Fall through to HTTP fallback
        }
      }

      if (wsOnly) return;

      void fetch('/api/obs/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {
        // Ignore transient overlay relay failures
      });
    },
    [],
  );

  // Initialize OBS WebSocket client, `/ws/obs` bidirectional relay (for Browser Source Bridge),
  // BroadcastChannel, audio device enumeration & duck state sync
  useEffect(() => {
    const engine = engineRef.current!;
    let disposed = false;
    let reconnectTimer: number | null = null;

    const handleBridgeMessage = (msg: ObsBroadcastPayload & { clients?: number }) => {
      if ((msg as { type?: string }).type === 'connected' && typeof msg.clients === 'number') {
        setObsClientsCount(Math.max(0, msg.clients));
        return;
      }
      if (msg.type === 'obs_bridge_status') {
        if (bridgeConnectTimeoutRef.current !== null) {
          window.clearTimeout(bridgeConnectTimeoutRef.current);
          bridgeConnectTimeoutRef.current = null;
        }
        if (msg.bridgeState) setObsWsState(msg.bridgeState);
        if (msg.bridgeMessage) setObsWsMessage(msg.bridgeMessage);
        if (Array.isArray(msg.bridgeSources)) {
          setObsSources(msg.bridgeSources);
          const currentTarget = latestStateRef.current.obsWsConfig.targetSourceName;
          if (
            msg.bridgeSources.length > 0 &&
            !msg.bridgeSources.includes(currentTarget)
          ) {
            setObsWsConfig((prev) => ({
              ...prev,
              targetSourceName: msg.bridgeSources![0],
            }));
          }
        }
      }
    };

    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel('dubcast-obs-sync');
      obsRelayChannelRef.current = ch;
      ch.onmessage = (event) => {
        if (event.data) handleBridgeMessage(event.data);
      };
    }

    let pingTimer: number | null = null;
    const connectRelayWs = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(
        `${proto}//${window.location.host}/ws/obs?role=console`,
      );
      obsRelayWsRef.current = socket;
      socket.onmessage = (event) => {
        try {
          handleBridgeMessage(JSON.parse(String(event.data)));
        } catch {
          // Ignore malformed JSON
        }
      };
      socket.onclose = () => {
        if (obsRelayWsRef.current === socket) {
          obsRelayWsRef.current = null;
        }
        if (!disposed) {
          reconnectTimer = window.setTimeout(connectRelayWs, 2500);
        }
      };
    };
    connectRelayWs();

    pingTimer = window.setInterval(() => {
      const sock = obsRelayWsRef.current;
      if (sock && sock.readyState === WebSocket.OPEN) {
        try {
          sock.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Ignore
        }
      }
    }, 20_000);

    obsWsClientRef.current = new ObsWebSocketClient((state, msg) => {
      if (latestStateRef.current.obsWsConfig.transport === 'direct') {
        setObsWsState(state);
        if (msg) setObsWsMessage(msg);
      }
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

        const {
          obsWsConfig: cfg,
          obsWsState: curObsState,
          duckingConfig: dCfg,
        } = latestStateRef.current;

        if (!cfg.autoControlSource || !cfg.targetSourceName.trim()) {
          return;
        }

        if (cfg.transport === 'browser_source_bridge') {
          if (curObsState !== 'connected') return;
          if (dCfg.mode === 'replace_on_speech' || dCfg.mode === 'replace_always') {
            broadcastToObsOverlay({
              type: 'obs_bridge_mute',
              sourceName: cfg.targetSourceName,
              muted: isOriginalMuted,
            });
          } else if (dCfg.mode === 'auto_duck') {
            broadcastToObsOverlay({
              type: 'obs_bridge_volume',
              sourceName: cfg.targetSourceName,
              volumeDb: isDucking ? dCfg.duckLevelDb : 0,
            });
          }
          return;
        }

        const wsClient = obsWsClientRef.current;
        if (wsClient && wsClient.getState() === 'connected') {
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

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pingTimer !== null) window.clearInterval(pingTimer);
      if (bridgeConnectTimeoutRef.current !== null) {
        window.clearTimeout(bridgeConnectTimeoutRef.current);
      }
      unsubDuck();
      liveSocketRef.current?.close();
      obsRelayWsRef.current?.close();
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

  // Receive 1 FPS JPEG vision frame from CameraStudioView
  const handleVisionFrame = useCallback(
    (base64Jpeg: string, dataUrl: string) => {
      latestCameraFrameRef.current = base64Jpeg;

      const { cameraConfig: camCfg, livePipelineMode: curPipeline } =
        latestStateRef.current;

      // 1. Stream 1 FPS JPEG video frame into active Gemini 3.8 Live Realtime session
      if (
        camCfg.sendVisionToGemini &&
        curPipeline === 'live_realtime' &&
        liveSocketRef.current?.readyState === WebSocket.OPEN
      ) {
        try {
          liveSocketRef.current.send(
            JSON.stringify({ type: 'video', data: base64Jpeg }),
          );
        } catch {
          // Ignore transient send error
        }
      }

      // 2. Relay PiP frame to OBS Browser Source over WebSocket (wsOnly=true avoids HTTP spam)
      if (camCfg.sendVideoToObs) {
        broadcastToObsOverlay(
          {
            type: 'camera_frame',
            cameraFrameDataUrl: dataUrl,
            timestamp: Date.now(),
          },
          true,
        );
      }
    },
    [broadcastToObsOverlay],
  );

  const handleCameraActiveChange = useCallback((active: boolean) => {
    setCameraActive(active);
    if (!active) {
      latestCameraFrameRef.current = '';
    }
  }, []);

  // Local Model: Fetch available models (Ollama /api/tags or OpenAI /v1/models)
  const handleFetchLocalModels = async () => {
    const cfg = localModelConfig;
    setLocalModelStatus({ state: 'loading', message: 'Загрузка списка моделей…' });
    try {
      let models: string[] = [];
      if (cfg.transport === 'browser_direct') {
        const endpoint = buildLocalModelsEndpoint(cfg.baseUrl, cfg.protocol);
        const headers: Record<string, string> = {};
        if (cfg.apiKey.trim()) {
          headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
        }
        const res = await fetch(endpoint, { method: 'GET', headers });
        if (!res.ok) {
          throw new Error(`Сервер вернул статус ${res.status} (${endpoint}).`);
        }
        const json = await res.json();
        models = parseLocalModelList(cfg.protocol, json);
      } else {
        const res = await fetch('/api/local-models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: cfg.baseUrl,
            protocol: cfg.protocol,
            apiKey: cfg.apiKey,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Не удалось получить список моделей.');
        }
        models = Array.isArray(data.models) ? data.models : [];
      }

      setDiscoveredLocalModels(models);
      if (models.length > 0) {
        if (!models.includes(cfg.modelName)) {
          setLocalModelConfig((prev) => ({ ...prev, modelName: models[0] }));
        }
        setLocalModelStatus({
          state: 'ok',
          message: `Найдено моделей: ${models.length} (${models.slice(0, 3).join(', ')}${models.length > 3 ? '…' : ''}).`,
        });
      } else {
        setLocalModelStatus({
          state: 'ok',
          message: 'Сервер ответил, но список установленных моделей пуст.',
        });
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const corsHint =
        cfg.transport === 'browser_direct' &&
        (raw.includes('Failed to fetch') || raw.includes('NetworkError'))
          ? `Браузер не смог подключиться к ${cfg.baseUrl}. Проверьте, что Ollama / LM Studio запущены на ПК и разрешён CORS (для Ollama: OLLAMA_ORIGINS=*).`
          : raw;
      setLocalModelStatus({ state: 'error', message: corsHint });
    }
  };

  // Local Model: Test translation round-trip
  const translateWithLocalModel = useCallback(
    async (
      text: string,
      srcCode: string,
      tgtCode: string,
      cfg: LocalModelConfig,
    ): Promise<{ translatedText: string; translateMs: number }> => {
      if (!cfg.modelName.trim()) {
        throw new Error('Укажите имя локальной модели (например, qwen2.5:7b).');
      }

      const started = Date.now();
      if (cfg.transport === 'browser_direct') {
        const endpoint = buildLocalChatEndpoint(cfg.baseUrl, cfg.protocol);
        const body = buildLocalTranslateRequest({
          protocol: cfg.protocol,
          modelName: cfg.modelName,
          text,
          sourceLangName: getLangDisplayName(srcCode),
          targetLangName: getLangDisplayName(tgtCode),
        });
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (cfg.apiKey.trim()) {
          headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
        }
        let res: Response;
        try {
          res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Не удалось подключиться к локальной модели (${endpoint}): ${detail}. Убедитесь, что сервер запущен на ПК и включён CORS (OLLAMA_ORIGINS=*).`,
          );
        }
        if (!res.ok) {
          throw new Error(
            `Локальная модель вернула ошибку ${res.status} (${endpoint}).`,
          );
        }
        const json = await res.json();
        const translatedText = extractLocalTranslationText(cfg.protocol, json);
        if (!translatedText) {
          throw new Error('Локальная модель вернула пустой ответ.');
        }
        return { translatedText, translateMs: Date.now() - started };
      }

      const res = await fetch('/api/local-translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: cfg.baseUrl,
          protocol: cfg.protocol,
          modelName: cfg.modelName,
          apiKey: cfg.apiKey,
          text,
          sourceLang: srcCode,
          targetLang: tgtCode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Ошибка локальной модели перевода.');
      }
      return {
        translatedText: data.translatedText,
        translateMs: data.translateMs || Date.now() - started,
      };
    },
    [],
  );

  const handleTestLocalModel = async () => {
    setLocalModelStatus({
      state: 'loading',
      message: `Тестовый перевод через ${localModelConfig.modelName || 'локальную модель'}…`,
    });
    try {
      const res = await translateWithLocalModel(
        'Welcome to the live broadcast!',
        'en',
        targetLang,
        localModelConfig,
      );
      setLocalModelStatus({
        state: 'ok',
        message: `Готово (${res.translateMs} мс): «${res.translatedText}»`,
      });
    } catch (err) {
      setLocalModelStatus({
        state: 'error',
        message:
          err instanceof Error ? err.message : 'Локальная модель недоступна.',
      });
    }
  };

  /**
   * Core pipeline:
   * 1. Translate text via Local LLM (Ollama / LM Studio) OR Gemini 3.1 Flash Lite (+ optional camera vision frame)
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
        localModelConfig: curLocal,
        cameraConfig: curCam,
        cameraActive: isCamOn,
      } = latestStateRef.current;

      const effectiveSource = overrideSourceLang || curSrc;

      setErrorBanner('');
      setIsProcessing(true);

      try {
        // Step 1: Translate (Local LLM or Gemini Cloud)
        let translatedText = '';
        let translateMs = 0;
        let translatorLabel = 'Gemini 3.1';

        const runGeminiTranslate = async () => {
          const includeFrame =
            isCamOn &&
            curCam.sendVisionToGemini &&
            latestCameraFrameRef.current.length > 100;

          setProcessingStage(
            includeFrame
              ? 'Перевод с контекстом камеры (Gemini 3.1 Vision)…'
              : 'Перевод реплики (Gemini 3.1 Flash Lite)…',
          );
          const trRes = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: clean,
              sourceLang: effectiveSource,
              targetLang: curTgt,
              videoFrameBase64: includeFrame
                ? latestCameraFrameRef.current
                : undefined,
            }),
          });
          const trData = await trRes.json();
          if (!trRes.ok) {
            throw new Error(trData.error || 'Ошибка перевода речи');
          }
          return {
            translatedText: String(trData.translatedText),
            translateMs: Number(trData.translateMs || 0),
          };
        };

        if (curLocal.provider === 'local') {
          setProcessingStage(
            `Перевод локальной моделью (${curLocal.modelName || 'LLM'})…`,
          );
          try {
            const localRes = await translateWithLocalModel(
              clean,
              effectiveSource,
              curTgt,
              curLocal,
            );
            translatedText = localRes.translatedText;
            translateMs = localRes.translateMs;
            translatorLabel = `Local: ${curLocal.modelName}`;
          } catch (localErr) {
            if (!curLocal.fallbackToGemini) {
              throw localErr;
            }
            const fallbackRes = await runGeminiTranslate();
            translatedText = fallbackRes.translatedText;
            translateMs = fallbackRes.translateMs;
            translatorLabel = 'Gemini (резерв)';
          }
        } else {
          const gemRes = await runGeminiTranslate();
          translatedText = gemRes.translatedText;
          translateMs = gemRes.translateMs;
        }

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
          const pcmChunks: string[] = [];

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
                pcmChunks.push(event.data);
                engineRef.current?.enqueuePcm24kBase64(event.data);
                // Stream 24kHz PCM chunk directly to OBS Browser Source so OBS Mixer receives audio!
                broadcastToObsOverlay(
                  {
                    type: 'audio_pcm',
                    pcmBase64: event.data,
                    sampleRate: 24000,
                    ttsGainDb: curDuck.ttsGainDb,
                    timestamp: Date.now(),
                  },
                  true,
                );
              } else if (event.type === 'done') {
                ttsMs = event.ttsMs || 0;
              } else if (event.type === 'error') {
                throw new Error(event.error || 'Ошибка потокового TTS');
              }
            }
          }

          if (pcmChunks.length > 0) {
            audioBase64Wav = pcmChunksToWavBase64(pcmChunks, 24000);
          }
        } else {
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
              ttsGainDb: curDuck.ttsGainDb,
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
          translatorLabel,
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
    [broadcastToObsOverlay, translateWithLocalModel],
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
            broadcastToObsOverlay({ type: 'audio_stop' }, true);
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
            broadcastToObsOverlay(
              {
                type: 'audio_pcm',
                pcmBase64: msg.data,
                sampleRate: 24000,
                ttsGainDb: latestStateRef.current.duckingConfig.ttsGainDb,
                timestamp: Date.now(),
              },
              true,
            );
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

  // Download generated WAV audio for a transcript log entry (synthesizes & caches if not yet saved)
  const handleDownloadEntryAudio = async (entry: TranscriptEntry) => {
    setErrorBanner('');
    const safeTime = formatTimecode(entry.timestamp).replace(/:/g, '-');
    const filename = `dubcast_${safeTime}_${entry.voiceName.toLowerCase()}.wav`;

    if (entry.audioBase64Wav) {
      triggerWavDownload(entry.audioBase64Wav, filename);
      return;
    }

    setDownloadingEntryId(entry.id);
    try {
      const ttsRes = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: entry.translatedText,
          voiceName: entry.voiceName || voiceName,
          voiceStyle: entry.voiceStyle || voiceStyle,
          ttsModel: entry.ttsModel || ttsModel,
        }),
      });
      const data = await ttsRes.json();
      if (!ttsRes.ok || !data.audioBase64Wav) {
        throw new Error(data.error || 'Не удалось сгенерировать WAV-файл.');
      }

      const wav: string = data.audioBase64Wav;
      setEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, audioBase64Wav: wav } : e)),
      );
      triggerWavDownload(wav, filename);
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Не удалось скачать аудиофайл.',
      );
    } finally {
      setDownloadingEntryId(null);
    }
  };

  // Synthesize a single timestamp-stripped cue for TimedScriptPanel (optional translation + WAV)
  const handleSynthesizeTimedCue = useCallback(
    async (
      cleanText: string,
      shouldTranslate: boolean,
    ): Promise<TimedCueSynthResult> => {
      const {
        sourceLang: curSrc,
        targetLang: curTgt,
        voiceName: curVoice,
        ttsModel: curModel,
        voiceStyle: curStyle,
        localModelConfig: curLocal,
      } = latestStateRef.current;

      let spokenText = cleanText;
      let translateMs = 0;
      let translatorLabel = 'Тайминг (прямо)';

      if (shouldTranslate) {
        const runGeminiTr = async () => {
          const trRes = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: cleanText,
              sourceLang: curSrc,
              targetLang: curTgt,
            }),
          });
          const trData = await trRes.json();
          if (!trRes.ok) {
            throw new Error(trData.error || 'Ошибка перевода реплики');
          }
          return {
            translatedText: String(trData.translatedText),
            translateMs: Number(trData.translateMs || 0),
          };
        };

        if (curLocal.provider === 'local') {
          try {
            const localRes = await translateWithLocalModel(
              cleanText,
              curSrc,
              curTgt,
              curLocal,
            );
            spokenText = localRes.translatedText;
            translateMs = localRes.translateMs;
            translatorLabel = `Local: ${curLocal.modelName}`;
          } catch (localErr) {
            if (!curLocal.fallbackToGemini) throw localErr;
            const fallback = await runGeminiTr();
            spokenText = fallback.translatedText;
            translateMs = fallback.translateMs;
            translatorLabel = 'Gemini (резерв)';
          }
        } else {
          const gem = await runGeminiTr();
          spokenText = gem.translatedText;
          translateMs = gem.translateMs;
          translatorLabel = 'Gemini 3.1';
        }
      }

      const ttsRes = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: spokenText,
          voiceName: curVoice,
          voiceStyle: curStyle,
          ttsModel: curModel,
        }),
      });
      const ttsData = await ttsRes.json();
      if (!ttsRes.ok || !ttsData.audioBase64Wav) {
        throw new Error(ttsData.error || 'Ошибка синтеза речи для тайминга');
      }

      return {
        originalText: cleanText,
        spokenText,
        audioBase64Wav: ttsData.audioBase64Wav,
        translateMs,
        ttsMs: Number(ttsData.ttsMs || 0),
        translatorLabel,
      };
    },
    [translateWithLocalModel],
  );

  // Triggered at exact timestamp by TimedScriptPanel master clock
  const handlePlayTimedCue = useCallback(
    (cue: TimedCue, synth: TimedCueSynthResult) => {
      const {
        sourceLang: curSrc,
        targetLang: curTgt,
        voiceName: curVoice,
        ttsModel: curModel,
        voiceStyle: curStyle,
        duckingConfig: curDuck,
      } = latestStateRef.current;

      broadcastToObsOverlay({
        type: 'subtitle',
        originalText: synth.originalText,
        translatedText: synth.spokenText,
        timestamp: Date.now(),
      });

      broadcastToObsOverlay({
        type: 'audio_wav',
        originalText: synth.originalText,
        translatedText: synth.spokenText,
        audioBase64Wav: synth.audioBase64Wav,
        ttsGainDb: curDuck.ttsGainDb,
        timestamp: Date.now(),
      });

      void engineRef.current?.playWavBase64(synth.audioBase64Wav);

      const logEntry: TranscriptEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
        sourceLang: curSrc,
        targetLang: curTgt,
        originalText: `[${cue.timeLabel}] ${synth.originalText}`,
        translatedText: synth.spokenText,
        voiceName: curVoice,
        ttsModel: curModel,
        voiceStyle: curStyle,
        translatorLabel: synth.translatorLabel
          ? `${synth.translatorLabel} · ${cue.timeLabel}`
          : `Тайминг ${cue.timeLabel}`,
        translateMs: synth.translateMs,
        ttsMs: synth.ttsMs,
        audioBase64Wav: synth.audioBase64Wav,
      };
      setEntries((prev) => [logEntry, ...prev]);
    },
    [broadcastToObsOverlay],
  );

  // OBS WebSocket v5 Connect / Disconnect / Test (supports both Browser Source Bridge & Direct mode)
  const handleConnectObsWs = async () => {
    if (obsWsConfig.transport === 'browser_source_bridge') {
      if (obsClientsCount <= 0) {
        setObsWsState('error');
        setObsWsMessage(
          'Сначала добавьте URL из блока 1 («Источник браузера OBS») в сцену OBS Studio (или откройте его кнопкой «Открыть оверлей»). Когда счётчик «Подключено оверлеев» станет ≥ 1, нажмите «Подключить через Browser Source» — плагин свяжется с OBS напрямую на вашем ПК без блокировки HTTPS.',
        );
        return;
      }

      setObsWsState('connecting');
      setObsWsMessage(
        `Отправка команды подключения в Browser Source внутри OBS (${obsWsConfig.host}:${obsWsConfig.port})…`,
      );

      broadcastToObsOverlay({
        type: 'obs_bridge_connect',
        bridgeConfig: {
          host: obsWsConfig.host.trim(),
          port: obsWsConfig.port,
          password: obsWsConfig.password,
          useTls: obsWsConfig.useTls,
          targetSourceName: obsWsConfig.targetSourceName,
        },
        timestamp: Date.now(),
      });

      if (bridgeConnectTimeoutRef.current !== null) {
        window.clearTimeout(bridgeConnectTimeoutRef.current);
      }
      bridgeConnectTimeoutRef.current = window.setTimeout(() => {
        if (latestStateRef.current.obsWsState === 'connecting') {
          setObsWsState('error');
          setObsWsMessage(
            `Browser Source не ответил за 6 секунд. Убедитесь, что источник браузера активен в текущей сцене OBS, а сервер WebSocket включён на порту ${obsWsConfig.port}.`,
          );
        }
      }, 6000);
      return;
    }

    try {
      const sources = await obsWsClientRef.current!.connect(
        obsWsConfig.host.trim(),
        obsWsConfig.port,
        obsWsConfig.password,
        obsWsConfig.useTls,
      );
      setObsSources(sources);
      if (sources.length > 0 && !sources.includes(obsWsConfig.targetSourceName)) {
        setObsWsConfig((prev) => ({ ...prev, targetSourceName: sources[0] }));
      }
    } catch {
      // Error state & diagnostic message already handled by ObsWebSocketClient callback
    }
  };

  const handleDisconnectObsWs = () => {
    if (obsWsConfig.transport === 'browser_source_bridge') {
      broadcastToObsOverlay({ type: 'obs_bridge_disconnect' });
      setObsWsState('disconnected');
      setObsWsMessage('Отключено от OBS WebSocket.');
      return;
    }
    obsWsClientRef.current?.disconnect();
  };

  const handleTestObsMute = async () => {
    if (obsWsState !== 'connected') return;

    if (obsWsConfig.transport === 'browser_source_bridge') {
      broadcastToObsOverlay({
        type: 'obs_bridge_mute',
        sourceName: obsWsConfig.targetSourceName,
        muted: true,
      });
      setObsWsMessage(
        `Источник «${obsWsConfig.targetSourceName}» заглушён через Browser Source на 2 секунды…`,
      );
      window.setTimeout(() => {
        broadcastToObsOverlay({
          type: 'obs_bridge_mute',
          sourceName: obsWsConfig.targetSourceName,
          muted: false,
        });
        setObsWsMessage(
          `Источник «${obsWsConfig.targetSourceName}» успешно восстановлен.`,
        );
      }, 2000);
      return;
    }

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
    cameras: 'Камеры (Vision Studio)',
    obs: 'Плагин OBS Studio',
    log: 'Журнал эфира',
  };

  const navItems: { id: AppTab; label: string; icon: typeof Sliders }[] = [
    { id: 'console', label: 'Пульт перевода', icon: Sliders },
    { id: 'cameras', label: 'Камеры', icon: Camera },
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
            Дикторская озвучка + Локальная LLM / Gemini
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
            Нативный голос + видеопоток камеры
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
                className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                  active
                    ? 'bg-[#1A202E] text-white'
                    : 'text-[#8B95A7] hover:text-[#E6ECF5] hover:bg-white/[0.03]'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.id === 'cameras' && cameraActive && (
                  <span
                    className="w-2 h-2 rounded-full bg-[#34D399] shrink-0"
                    title="Камера активна"
                  />
                )}
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
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-md text-sm font-medium ${
                      active
                        ? 'bg-[#1A202E] text-white'
                        : 'text-[#8B95A7] hover:text-white'
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon className="w-4 h-4" />
                      <span>{item.label}</span>
                    </span>
                    {item.id === 'cameras' && cameraActive && (
                      <span className="w-2 h-2 rounded-full bg-[#34D399]" />
                    )}
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

          <div className={activeTab === 'console' ? 'block' : 'hidden'}>
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
              onSynthesizeTimedCue={handleSynthesizeTimedCue}
              onPlayTimedCue={handlePlayTimedCue}
              recentEntries={entries}
              onReplayEntry={(e) => void handleReplayEntry(e)}
              onStopAudio={() => {
                engineRef.current?.stopAllTts();
                engineRef.current?.stopOriginalClip();
                broadcastToObsOverlay({ type: 'audio_stop' }, true);
              }}
              localModelConfig={localModelConfig}
              onChangeLocalModelConfig={setLocalModelConfig}
              discoveredLocalModels={discoveredLocalModels}
              localModelStatus={localModelStatus}
              onFetchLocalModels={handleFetchLocalModels}
              onTestLocalModel={handleTestLocalModel}
            />
          </div>

          {/* Keep CameraStudioView mounted so camera stream & 1 FPS Vision/OBS PiP stay alive across tabs */}
          <div className={activeTab === 'cameras' ? 'block' : 'hidden'}>
            <CameraStudioView
              config={cameraConfig}
              onChangeConfig={setCameraConfig}
              isLive={isLive}
              onVisionFrame={handleVisionFrame}
              onCameraActiveChange={handleCameraActiveChange}
            />
          </div>

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
              onDisconnectObsWs={handleDisconnectObsWs}
              onTestObsMute={handleTestObsMute}
              onTestObsOverlayAudio={() => {
                broadcastToObsOverlay({
                  type: 'test_audio',
                  originalText: 'OBS Audio Channel Check',
                  translatedText:
                    'Проверка канала озвучки OBS — звук Gemini 3.8 Flash TTS активен',
                  timestamp: Date.now(),
                });
              }}
              duckingConfig={duckingConfig}
              latestOriginal={entries[0]?.originalText || ''}
              latestTranslated={entries[0]?.translatedText || ''}
              obsClientsCount={obsClientsCount}
            />
          )}

          {activeTab === 'log' && (
            <TranscriptLogView
              entries={entries}
              downloadingEntryId={downloadingEntryId}
              onReplayEntry={(e) => void handleReplayEntry(e)}
              onDownloadEntryAudio={handleDownloadEntryAudio}
              onClearEntries={() => setEntries([])}
              onJumpToConsole={() => setActiveTab('console')}
            />
          )}
        </main>
      </div>
    </div>
  );
}
