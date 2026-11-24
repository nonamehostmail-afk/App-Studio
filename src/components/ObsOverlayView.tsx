import { useCallback, useEffect, useRef, useState } from 'react';
import { EyeOff, Volume2, VolumeX } from 'lucide-react';
import type { ObsBroadcastPayload } from '../types/translator';
import {
  base64ToUint8,
  dbToGain,
  pcm16Base64ToFloat32,
} from '../utils/duckingMath';
import { ObsWebSocketClient } from '../utils/obsWebSocket';

/**
 * Dedicated transparent OBS Browser Source view (`/?mode=obs`).
 * 1. Receives real-time translated subtitles, camera PiP frames, streaming 24kHz PCM audio,
 *    and complete WAV audio from Gemini 3.8 Flash TTS via `/ws/obs?role=overlay` and `BroadcastChannel`.
 * 2. Keeps an imperceptible Web Audio keepalive stream running when audio output is enabled so
 *    OBS Studio's "Control audio via OBS" immediately registers the track in the Audio Mixer.
 * 3. Acts as a Local OBS WebSocket v5 Bridge inside OBS Studio's own CEF browser.
 */
export function ObsOverlayView() {
  const params = new URLSearchParams(window.location.search);
  const [showSubtitles, setShowSubtitles] = useState(params.get('subs') !== '0');
  const [showOriginal, setShowOriginal] = useState(params.get('orig') !== '0');
  const [position, setPosition] = useState<'bottom' | 'top'>(
    params.get('pos') === 'top' ? 'top' : 'bottom',
  );
  const [fontSize, setFontSize] = useState<'sm' | 'md' | 'lg'>(
    params.get('size') === 'lg'
      ? 'lg'
      : params.get('size') === 'sm'
        ? 'sm'
        : 'md',
  );
  const [outputAudio, setOutputAudio] = useState(params.get('audio') !== '0');
  const [showCameraPip, setShowCameraPip] = useState(params.get('cam') === '1');

  const [originalText, setOriginalText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [cameraFrameUrl, setCameraFrameUrl] = useState('');
  const [isVisible, setIsVisible] = useState(false);

  // Detect whether running inside OBS Studio's CEF Browser Source or a regular desktop browser
  const isObsCef =
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { obsstudio?: unknown }).obsstudio);

  const [wsConnected, setWsConnected] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(isObsCef);
  const [isAudioActive, setIsAudioActive] = useState(false);
  const [hudHidden, setHudHidden] = useState(isObsCef);

  const hideTimerRef = useRef<number | null>(null);
  const audioIndicatorTimerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const keepaliveOscRef = useRef<OscillatorNode | null>(null);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextPcmTimeRef = useRef<number>(0);
  const outputAudioRef = useRef(outputAudio);
  outputAudioRef.current = outputAudio;

  useEffect(() => {
    document.body.classList.add('obs-overlay-mode');
    return () => {
      document.body.classList.remove('obs-overlay-mode');
    };
  }, []);

  const ensureAudioGraph = useCallback(async (): Promise<AudioContext | null> => {
    if (!outputAudioRef.current) return null;
    try {
      if (!audioCtxRef.current) {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new AudioCtx();
        const master = ctx.createGain();
        master.gain.value = 1.0;
        master.connect(ctx.destination);

        // Imperceptible -100dB keepalive signal so OBS Studio "Управление аудио через OBS"
        // detects the Browser Source audio stream in the Audio Mixer immediately on load.
        const keepaliveOsc = ctx.createOscillator();
        const keepaliveGain = ctx.createGain();
        keepaliveOsc.frequency.value = 1;
        keepaliveGain.gain.value = 0.00001;
        keepaliveOsc.connect(keepaliveGain);
        keepaliveGain.connect(master);
        keepaliveOsc.start();

        audioCtxRef.current = ctx;
        masterGainRef.current = master;
        keepaliveOscRef.current = keepaliveOsc;
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }
      const running = ctx.state === 'running';
      setAudioUnlocked(running);
      return running ? ctx : null;
    } catch {
      return null;
    }
  }, []);

  const pulseAudioIndicator = useCallback((durationMs = 1500) => {
    setIsAudioActive(true);
    if (audioIndicatorTimerRef.current !== null) {
      window.clearTimeout(audioIndicatorTimerRef.current);
    }
    audioIndicatorTimerRef.current = window.setTimeout(() => {
      setIsAudioActive(false);
    }, durationMs);
  }, []);

  const stopAllAudio = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // Ignore already stopped
      }
    }
    activeSourcesRef.current.clear();
    nextPcmTimeRef.current = 0;
    setIsAudioActive(false);
  }, []);

  const playTestChime = useCallback(async () => {
    const ctx = await ensureAudioGraph();
    if (!ctx || !masterGainRef.current) return;

    const now = ctx.currentTime + 0.02;
    const notes = [523.25, 659.25, 783.99]; // C5 - E5 - G5 studio broadcast chime
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;

      const t0 = now + idx * 0.14;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(0.24, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42);

      osc.connect(gain);
      gain.connect(masterGainRef.current!);
      osc.start(t0);
      osc.stop(t0 + 0.45);
    });
    pulseAudioIndicator(1200);
  }, [ensureAudioGraph, pulseAudioIndicator]);

  const enqueuePcmBase64 = useCallback(
    async (base64Pcm: string, sampleRate = 24000, ttsGainDb = 0) => {
      const ctx = await ensureAudioGraph();
      if (!ctx || !masterGainRef.current) return;

      const floatSamples = pcm16Base64ToFloat32(base64Pcm);
      if (floatSamples.length === 0) return;

      masterGainRef.current.gain.setTargetAtTime(
        dbToGain(ttsGainDb),
        ctx.currentTime,
        0.02,
      );

      const audioBuffer = ctx.createBuffer(1, floatSamples.length, sampleRate);
      const copy = new Float32Array(new ArrayBuffer(floatSamples.byteLength));
      copy.set(floatSamples);
      audioBuffer.copyToChannel(copy, 0);

      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(masterGainRef.current);

      const now = ctx.currentTime;
      const startAt = Math.max(now + 0.02, nextPcmTimeRef.current);
      nextPcmTimeRef.current = startAt + audioBuffer.duration;

      activeSourcesRef.current.add(src);
      src.onended = () => {
        activeSourcesRef.current.delete(src);
      };
      src.start(startAt);
      pulseAudioIndicator(Math.max(800, audioBuffer.duration * 1000 + 400));
    },
    [ensureAudioGraph, pulseAudioIndicator],
  );

  const playWavInOverlay = useCallback(
    async (base64Wav: string, ttsGainDb = 0) => {
      const ctx = await ensureAudioGraph();
      if (!ctx || !masterGainRef.current) return;
      try {
        masterGainRef.current.gain.setTargetAtTime(
          dbToGain(ttsGainDb),
          ctx.currentTime,
          0.02,
        );
        const bytes = base64ToUint8(base64Wav);
        const arrayBuf = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(arrayBuf).set(bytes);
        const buf = await ctx.decodeAudioData(arrayBuf);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(masterGainRef.current);
        activeSourcesRef.current.add(src);
        src.onended = () => {
          activeSourcesRef.current.delete(src);
        };
        src.start();
        pulseAudioIndicator(Math.max(1000, buf.duration * 1000 + 300));
      } catch {
        // Ignore decode errors on malformed WAV
      }
    },
    [ensureAudioGraph, pulseAudioIndicator],
  );

  // Proactively boot audio graph (succeeds immediately inside OBS CEF; unlocks on first click in Chrome)
  useEffect(() => {
    void ensureAudioGraph();
    const unlock = () => {
      void ensureAudioGraph();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [ensureAudioGraph]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let channel: BroadcastChannel | null = null;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let disposed = false;

    const sendBack = (msg: ObsBroadcastPayload) => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      } catch {
        // Ignore ws send error
      }
      try {
        channel?.postMessage(msg);
      } catch {
        // Ignore channel send error
      }
    };

    const showSubtitleBanner = (orig?: string, trans?: string) => {
      if (orig !== undefined) setOriginalText(orig);
      if (trans !== undefined) {
        setTranslatedText(trans);
        setIsVisible(true);
        if (hideTimerRef.current !== null) {
          window.clearTimeout(hideTimerRef.current);
        }
        hideTimerRef.current = window.setTimeout(() => {
          setIsVisible(false);
        }, 9000);
      }
    };

    // Embedded local OBS WebSocket v5 client (runs natively inside OBS Studio CEF!)
    const localObsClient = new ObsWebSocketClient((state, message) => {
      sendBack({
        type: 'obs_bridge_status',
        bridgeState: state,
        bridgeMessage: message,
        timestamp: Date.now(),
      });
    });

    const handlePayload = (payload: ObsBroadcastPayload) => {
      if (payload.type === 'config' && payload.config) {
        if (typeof payload.config.showSubtitles === 'boolean') {
          setShowSubtitles(payload.config.showSubtitles);
        }
        if (typeof payload.config.showOriginal === 'boolean') {
          setShowOriginal(payload.config.showOriginal);
        }
        if (payload.config.position) setPosition(payload.config.position);
        if (payload.config.fontSize) setFontSize(payload.config.fontSize);
        if (typeof payload.config.outputAudioInOverlay === 'boolean') {
          setOutputAudio(payload.config.outputAudioInOverlay);
        }
        if (typeof payload.config.showCameraPip === 'boolean') {
          setShowCameraPip(payload.config.showCameraPip);
        }
        return;
      }

      if (payload.type === 'camera_frame' && payload.cameraFrameDataUrl) {
        setCameraFrameUrl(payload.cameraFrameDataUrl);
        return;
      }

      if (payload.type === 'audio_pcm' && payload.pcmBase64) {
        void enqueuePcmBase64(
          payload.pcmBase64,
          payload.sampleRate || 24000,
          payload.ttsGainDb ?? 0,
        );
        return;
      }

      if (payload.type === 'audio_stop') {
        stopAllAudio();
        return;
      }

      if (payload.type === 'test_audio') {
        showSubtitleBanner(
          payload.originalText || 'OBS Audio Channel Check',
          payload.translatedText ||
            'Проверка канала озвучки OBS — звук Gemini 3.8 Flash TTS активен',
        );
        void playTestChime();
        return;
      }

      if (payload.type === 'obs_bridge_connect' && payload.bridgeConfig) {
        const cfg = payload.bridgeConfig;
        void localObsClient
          .connect(cfg.host, cfg.port, cfg.password, cfg.useTls)
          .then((sources) => {
            sendBack({
              type: 'obs_bridge_status',
              bridgeState: 'connected',
              bridgeMessage: `Подключено через Browser Source внутри OBS (${cfg.host}:${cfg.port})`,
              bridgeSources: sources,
              timestamp: Date.now(),
            });
          })
          .catch((err) => {
            sendBack({
              type: 'obs_bridge_status',
              bridgeState: 'error',
              bridgeMessage:
                err instanceof Error
                  ? err.message
                  : 'Не удалось подключиться к OBS WebSocket из Browser Source.',
              timestamp: Date.now(),
            });
          });
        return;
      }

      if (payload.type === 'obs_bridge_disconnect') {
        localObsClient.disconnect();
        sendBack({
          type: 'obs_bridge_status',
          bridgeState: 'disconnected',
          bridgeMessage: 'Мост Browser Source отключён от OBS WebSocket.',
          timestamp: Date.now(),
        });
        return;
      }

      if (payload.type === 'obs_bridge_mute' && payload.sourceName) {
        void localObsClient
          .setInputMute(payload.sourceName, Boolean(payload.muted))
          .catch(() => {});
        return;
      }

      if (
        payload.type === 'obs_bridge_volume' &&
        payload.sourceName &&
        typeof payload.volumeDb === 'number'
      ) {
        void localObsClient
          .setInputVolumeDb(payload.sourceName, payload.volumeDb)
          .catch(() => {});
        return;
      }

      if (payload.type === 'clear') {
        setIsVisible(false);
        return;
      }

      if (payload.type === 'subtitle' || payload.type === 'audio_wav') {
        showSubtitleBanner(payload.originalText, payload.translatedText);
        if (payload.audioBase64Wav) {
          void playWavInOverlay(payload.audioBase64Wav, payload.ttsGainDb ?? 0);
        }
      }
    };

    const connectObsRelay = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(
        `${proto}//${window.location.host}/ws/obs?role=overlay`,
      );
      ws = socket;
      socket.onopen = () => {
        setWsConnected(true);
      };
      socket.onmessage = (event) => {
        try {
          handlePayload(JSON.parse(String(event.data)));
        } catch {
          // Ignore malformed ws messages
        }
      };
      socket.onclose = () => {
        setWsConnected(false);
        if (!disposed) {
          reconnectTimer = window.setTimeout(connectObsRelay, 2000);
        }
      };
    };

    connectObsRelay();

    pingTimer = window.setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Ignore
        }
      }
    }, 20_000);

    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('dubcast-obs-sync');
      channel.onmessage = (event) => {
        if (event.data) handlePayload(event.data as ObsBroadcastPayload);
      };
    }

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pingTimer !== null) window.clearInterval(pingTimer);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      if (audioIndicatorTimerRef.current !== null) {
        window.clearTimeout(audioIndicatorTimerRef.current);
      }
      stopAllAudio();
      try {
        keepaliveOscRef.current?.stop();
        void audioCtxRef.current?.close();
      } catch {
        // Ignore
      }
      ws?.close();
      channel?.close();
      localObsClient.disconnect();
    };
  }, [enqueuePcmBase64, playTestChime, playWavInOverlay, stopAllAudio]);

  const textSizeClass =
    fontSize === 'lg'
      ? 'text-3xl leading-snug'
      : fontSize === 'sm'
        ? 'text-lg leading-snug'
        : 'text-2xl leading-snug';

  return (
    <main
      data-testid="obs-overlay-root"
      className={`w-screen h-screen bg-transparent p-10 flex flex-col relative ${
        position === 'top' ? 'justify-start' : 'justify-end'
      } items-center`}
    >
      {/* Browser preview helper bar (automatically hidden inside OBS Studio CEF) */}
      {!hudHidden && (
        <div className="fixed top-4 left-4 right-4 max-w-3xl mx-auto bg-[#0E121B]/95 border border-white/15 rounded-lg px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs text-[#E6ECF5] shadow-xl z-20">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="font-display font-semibold text-white whitespace-nowrap">
              DubCast OBS Overlay
            </span>
            <span className="text-[#475569]">·</span>
            <span
              className={
                wsConnected ? 'text-[#34D399]' : 'text-[#F59E0B]'
              }
            >
              {wsConnected ? 'Подключено к пульту' : 'Подключение…'}
            </span>
            <span className="text-[#475569]">·</span>
            <span className="text-[#94A3B8] truncate">
              {!outputAudio
                ? 'Звук отключён в URL'
                : isAudioActive
                  ? 'Идёт звук озвучки'
                  : audioUnlocked
                    ? 'Аудиоканал готов'
                    : 'Нажмите «Включить звук»'}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {outputAudio && !audioUnlocked && (
              <button
                type="button"
                onClick={() => void playTestChime()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium bg-[#E11D48] hover:bg-[#BE123C] text-white transition-colors whitespace-nowrap"
              >
                <VolumeX className="w-3.5 h-3.5" />
                Включить звук
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOriginalText('OBS Audio Channel Check');
                setTranslatedText(
                  'Проверка канала озвучки OBS — звук Gemini 3.8 Flash TTS активен',
                );
                setIsVisible(true);
                if (hideTimerRef.current !== null) {
                  window.clearTimeout(hideTimerRef.current);
                }
                hideTimerRef.current = window.setTimeout(
                  () => setIsVisible(false),
                  7000,
                );
                void playTestChime();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/10 transition-colors whitespace-nowrap"
            >
              <Volume2 className="w-3.5 h-3.5" />
              Тест звука
            </button>
            <button
              type="button"
              onClick={() => setHudHidden(true)}
              title="Скрыть служебную панель для чистого захвата"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[#94A3B8] hover:text-white bg-transparent hover:bg-white/5 transition-colors whitespace-nowrap"
            >
              <EyeOff className="w-3.5 h-3.5" />
              Скрыть
            </button>
          </div>
        </div>
      )}

      {showCameraPip && cameraFrameUrl && (
        <div className="absolute top-6 right-6 w-72 aspect-video rounded-lg overflow-hidden border border-white/20 bg-[#0B0E14] shadow-2xl">
          <img
            src={cameraFrameUrl}
            alt="Поток камеры DubCast"
            className="w-full h-full object-cover"
          />
        </div>
      )}

      {showSubtitles && isVisible && translatedText ? (
        <div className="max-w-4xl w-full bg-[#0B0E14]/92 border border-white/15 rounded-lg px-7 py-5 shadow-2xl transition-opacity duration-200">
          {showOriginal && originalText && (
            <p className="text-sm text-[#94A3B8] mb-1.5 font-medium">
              {originalText}
            </p>
          )}
          <p className={`${textSizeClass} font-semibold text-white font-display`}>
            {translatedText}
          </p>
        </div>
      ) : (
        <div className="sr-only" aria-live="polite">
          DubCast OBS Browser Source готов к приёму потоковой озвучки PCM 24 кГц, титров и команд OBS WebSocket.
        </div>
      )}
    </main>
  );
}
