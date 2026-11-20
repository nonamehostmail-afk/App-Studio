import { useEffect, useRef, useState } from 'react';
import type { ObsBroadcastPayload } from '../types/translator';
import { base64ToUint8 } from '../utils/duckingMath';

/**
 * Dedicated transparent OBS Browser Source view (`/?mode=obs`).
 * Receives real-time translated subtitles and Gemini 3.8 Flash TTS audio
 * via `/ws/obs` and `BroadcastChannel` so OBS Studio can route translated voice
 * as an independent Audio Mixer track ("Control audio via OBS").
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

  const [originalText, setOriginalText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
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

    // 1. Server WebSocket sync (works across OBS CEF & external browsers)
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/obs`);
    ws.onmessage = (event) => {
      try {
        handlePayload(JSON.parse(String(event.data)));
      } catch {
        // Ignore
      }
    };

    // 2. Local BroadcastChannel fallback for same-browser testing
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('dubcast-obs-sync');
      channel.onmessage = (event) => {
        if (event.data) handlePayload(event.data as ObsBroadcastPayload);
      };
    }

    return () => {
      ws.close();
      channel?.close();
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
      className={`w-screen h-screen bg-transparent p-10 flex flex-col ${
        position === 'top' ? 'justify-start' : 'justify-end'
      } items-center`}
    >
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
          DubCast OBS Browser Source готов к приёму перевода и озвучки.
        </div>
      )}
    </main>
  );
}
