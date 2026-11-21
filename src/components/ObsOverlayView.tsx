import { useEffect, useRef, useState } from 'react';
import type { ObsBroadcastPayload } from '../types/translator';
import { base64ToUint8 } from '../utils/duckingMath';
import { ObsWebSocketClient } from '../utils/obsWebSocket';

/**
 * Dedicated transparent OBS Browser Source view (`/?mode=obs`).
 * 1. Receives real-time translated subtitles, camera PiP frames, and Gemini 3.8 Flash TTS audio
 *    via `/ws/obs` and `BroadcastChannel` so OBS Studio can route translated voice
 *    as an independent Audio Mixer track ("Control audio via OBS").
 * 2. Acts as a Local OBS WebSocket v5 Bridge inside OBS Studio's own CEF browser:
 *    connects directly to `ws://localhost:4455` on the user's PC (bypassing HTTPS/iframe
 *    browser security blocks) and executes mute/volume commands relayed from the Console.
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

  const hideTimerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioRef = useRef(outputAudio);
  outputAudioRef.current = outputAudio;

  useEffect(() => {
    document.body.classList.add('obs-overlay-mode');
    return () => {
      document.body.classList.remove('obs-overlay-mode');
    };
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let channel: BroadcastChannel | null = null;
    let reconnectTimer: number | null = null;
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

    // Embedded local OBS WebSocket v5 client (runs natively inside OBS Studio CEF!)
    const localObsClient = new ObsWebSocketClient((state, message) => {
      sendBack({
        type: 'obs_bridge_status',
        bridgeState: state,
        bridgeMessage: message,
        timestamp: Date.now(),
      });
    });

    const playWavInOverlay = async (base64Wav: string) => {
      if (!outputAudioRef.current) return;
      try {
        if (!audioCtxRef.current) {
          const AudioCtx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext;
          audioCtxRef.current = new AudioCtx();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        const bytes = base64ToUint8(base64Wav);
        const arrayBuf = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(arrayBuf).set(bytes);
        const buf = await ctx.decodeAudioData(arrayBuf);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start();
      } catch {
        // Autoplay may be blocked in non-OBS tabs until gesture
      }
    };

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
        if (payload.originalText !== undefined) {
          setOriginalText(payload.originalText);
        }
        if (payload.translatedText !== undefined) {
          setTranslatedText(payload.translatedText);
          setIsVisible(true);
          if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
          }
          hideTimerRef.current = window.setTimeout(() => {
            setIsVisible(false);
          }, 9000);
        }
        if (payload.audioBase64Wav) {
          void playWavInOverlay(payload.audioBase64Wav);
        }
      }
    };

    const connectObsRelay = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${proto}//${window.location.host}/ws/obs`);
      ws = socket;
      socket.onmessage = (event) => {
        try {
          handlePayload(JSON.parse(String(event.data)));
        } catch {
          // Ignore malformed ws messages
        }
      };
      socket.onclose = () => {
        if (!disposed) {
          reconnectTimer = window.setTimeout(connectObsRelay, 2500);
        }
      };
    };

    connectObsRelay();

    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('dubcast-obs-sync');
      channel.onmessage = (event) => {
        if (event.data) handlePayload(event.data as ObsBroadcastPayload);
      };
    }

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
      channel?.close();
      localObsClient.disconnect();
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

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
          DubCast OBS Browser Source готов к приёму перевода, озвучки и команд OBS WebSocket.
        </div>
      )}
    </main>
  );
}
