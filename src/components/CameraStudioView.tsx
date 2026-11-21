import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CameraOff,
  FlipHorizontal2,
  Monitor,
  Radio,
  RefreshCw,
  Sparkles,
  Tv,
} from 'lucide-react';
import { CAMERA_FILTERS } from '../constants/presets';
import type { CameraConfig, CameraFilterMode } from '../types/translator';

type CameraSourceMode = 'off' | 'webcam' | 'screen' | 'demo';

interface CameraStudioViewProps {
  config: CameraConfig;
  onChangeConfig: (next: CameraConfig) => void;
  isLive: boolean;
  onVisionFrame: (base64Jpeg: string, dataUrl: string) => void;
  onCameraActiveChange: (active: boolean, sourceLabel: string) => void;
}

const RESOLUTION_MAP: Record<
  CameraConfig['resolution'],
  { width: number; height: number; label: string }
> = {
  '360p': { width: 640, height: 360, label: '640 × 360 (360p)' },
  '720p': { width: 1280, height: 720, label: '1280 × 720 (720p HD)' },
  '1080p': { width: 1920, height: 1080, label: '1920 × 1080 (1080p)' },
};

export function CameraStudioView({
  config,
  onChangeConfig,
  isLive,
  onVisionFrame,
  onCameraActiveChange,
}: CameraStudioViewProps) {
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [sourceMode, setSourceMode] = useState<CameraSourceMode>('off');
  const [cameraError, setCameraError] = useState('');
  const [framesSent, setFramesSent] = useState(0);
  const [actualResolution, setActualResolution] = useState('—');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const visionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const visionTimerRef = useRef<number | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  const refreshVideoDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setVideoDevices(devices.filter((d) => d.kind === 'videoinput'));
    } catch {
      // Ignore permission-restricted enumeration
    }
  }, []);

  useEffect(() => {
    void refreshVideoDevices();
  }, [refreshVideoDevices]);

  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (visionTimerRef.current !== null) {
      window.clearInterval(visionTimerRef.current);
      visionTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setSourceMode('off');
    setActualResolution('—');
    onCameraActiveChange(false, 'Выключена');
  }, [onCameraActiveChange]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  // Real-time Canvas Frame Processor loop (Vision Camera web equivalent)
  const startProcessorLoop = useCallback(
    (mode: Exclude<CameraSourceMode, 'off'>) => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (visionTimerRef.current !== null) {
        window.clearInterval(visionTimerRef.current);
      }

      const drawDemoFrame = (
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
        tMs: number,
      ) => {
        // Studio dark broadcast backdrop
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#0E1320');
        grad.addColorStop(0.55, '#151D2F');
        grad.addColorStop(1, '#0B0F19');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Subtle studio calibration grid
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        const step = Math.round(w / 12);
        for (let x = step; x < w; x += step) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
        for (let y = step; y < h; y += step) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }

        // Broadcast SMPTE reference strip (top-right, clear of top-left tally badge)
        const bars = [
          '#CBD5E1',
          '#FACC15',
          '#22D3EE',
          '#34D399',
          '#E879F9',
          '#E11D48',
          '#3B82F6',
        ];
        const barW = Math.round(w * 0.032);
        const barH = Math.round(h * 0.055);
        const startX = w - 32 - bars.length * barW;
        bars.forEach((color, idx) => {
          ctx.fillStyle = color;
          ctx.fillRect(startX + idx * barW, 24, barW, barH);
        });

        // Animated live audio/vision wave in center
        const t = tMs / 1000;
        ctx.save();
        ctx.strokeStyle = '#E11D48';
        ctx.lineWidth = 3;
        ctx.beginPath();
        const midY = h * 0.54;
        for (let x = 40; x <= w - 40; x += 6) {
          const norm = (x - 40) / (w - 80);
          const env = Math.sin(norm * Math.PI);
          const y =
            midY +
            Math.sin(norm * 16 + t * 3.8) * 34 * env +
            Math.cos(norm * 28 - t * 2.4) * 14 * env;
          if (x === 40) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 40; x <= w - 40; x += 6) {
          const norm = (x - 40) / (w - 80);
          const env = Math.sin(norm * Math.PI);
          const y =
            midY +
            Math.sin(norm * 12 - t * 2.9 + 1.1) * 26 * env +
            Math.sin(norm * 22 + t * 4.2) * 9 * env;
          if (x === 40) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();

        // Broadcast safe-area reticle
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(w * 0.08, h * 0.1, w * 0.84, h * 0.8);

        // Studio Camera Label & Timecode
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const tc = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}:${pad(Math.floor((now.getMilliseconds() / 1000) * 30))}`;

        ctx.fillStyle = '#F8FAFC';
        ctx.font = `600 ${Math.round(h * 0.044)}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText('CAM 01 · DUBCAST VISION STUDIO', 36, h * 0.25);

        ctx.fillStyle = '#94A3B8';
        ctx.font = `500 ${Math.round(h * 0.028)}px "JetBrains Mono", monospace`;
        ctx.fillText(
          `TC ${tc}   ·   ${w}×${h}   ·   VISION 1 FPS`,
          36,
          h * 0.31,
        );

        // Bottom tally strip
        ctx.fillStyle = 'rgba(11, 14, 20, 0.82)';
        ctx.fillRect(32, h - 68, w - 64, 40);
        ctx.fillStyle = '#E11D48';
        ctx.beginPath();
        ctx.arc(54, h - 48, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#E6ECF5';
        ctx.font = `500 ${Math.round(h * 0.025)}px "JetBrains Mono", monospace`;
        ctx.fillText(
          'ТЕСТОВЫЙ ВИДЕОПОТОК КАМЕРЫ · ФИЛЬТРЫ И GEMINI VISION АКТИВНЫ',
          72,
          h - 42,
        );
      };

      const renderFrame = (timestamp: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const curCfg = configRef.current;
        const filterObj =
          CAMERA_FILTERS.find((f) => f.id === curCfg.filter) ||
          CAMERA_FILTERS[0];

        let targetW = 960;
        let targetH = 540;
        const video = videoRef.current;
        if (mode !== 'demo' && video && video.videoWidth > 0 && video.videoHeight > 0) {
          targetW = Math.min(1280, video.videoWidth);
          targetH = Math.round((targetW * video.videoHeight) / video.videoWidth);
        }

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
          setActualResolution(`${targetW} × ${targetH}`);
        }

        ctx.save();
        ctx.filter = filterObj.cssFilter;
        if (curCfg.mirror) {
          ctx.translate(targetW, 0);
          ctx.scale(-1, 1);
        }

        if (mode === 'demo') {
          drawDemoFrame(ctx, targetW, targetH, timestamp);
        } else if (video && video.readyState >= 2) {
          ctx.drawImage(video, 0, 0, targetW, targetH);
        }
        ctx.restore();

        // Optional cinematic vignette overlay for 'vignette' frame processor mode
        if (curCfg.filter === 'vignette') {
          const radGrad = ctx.createRadialGradient(
            targetW / 2,
            targetH / 2,
            targetH * 0.25,
            targetW / 2,
            targetH / 2,
            targetW * 0.65,
          );
          radGrad.addColorStop(0, 'rgba(0,0,0,0)');
          radGrad.addColorStop(1, 'rgba(0,0,0,0.58)');
          ctx.fillStyle = radGrad;
          ctx.fillRect(0, 0, targetW, targetH);
        }

        rafRef.current = requestAnimationFrame(renderFrame);
      };

      rafRef.current = requestAnimationFrame(renderFrame);

      // Emit 1 FPS resized JPEG frame for Gemini Vision / Live Realtime & OBS PiP
      visionTimerRef.current = window.setInterval(() => {
        const srcCanvas = canvasRef.current;
        if (!srcCanvas || srcCanvas.width === 0 || srcCanvas.height === 0) return;

        const curCfg = configRef.current;
        if (!curCfg.sendVisionToGemini && !curCfg.sendVideoToObs) return;

        if (!visionCanvasRef.current) {
          visionCanvasRef.current = document.createElement('canvas');
        }
        const outCanvas = visionCanvasRef.current;
        const outW = 640;
        const outH = Math.max(
          240,
          Math.round((outW * srcCanvas.height) / srcCanvas.width),
        );
        outCanvas.width = outW;
        outCanvas.height = outH;
        const outCtx = outCanvas.getContext('2d');
        if (!outCtx) return;

        outCtx.drawImage(srcCanvas, 0, 0, outW, outH);
        const dataUrl = outCanvas.toDataURL('image/jpeg', 0.72);
        const base64Jpeg = dataUrl.split(',')[1] || '';
        if (base64Jpeg) {
          onVisionFrame(base64Jpeg, dataUrl);
          setFramesSent((c) => c + 1);
        }
      }, 1000);
    },
    [onVisionFrame],
  );

  const startWebcam = async () => {
    setCameraError('');
    stopCamera();
    try {
      const dims = RESOLUTION_MAP[config.resolution];
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: config.deviceId ? { exact: config.deviceId } : undefined,
          width: { ideal: dims.width },
          height: { ideal: dims.height },
          frameRate: { ideal: config.fps },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const trackLabel =
        stream.getVideoTracks()[0]?.label || 'Веб-камера / Виртуальная камера';
      setSourceMode('webcam');
      setFramesSent(0);
      onCameraActiveChange(true, trackLabel);
      void refreshVideoDevices();
      startProcessorLoop('webcam');
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Не удалось получить доступ к камере. Проверьте разрешения браузера или включите «Демо-камеру».';
      setCameraError(msg);
      stopCamera();
    }
  };

  const startScreenCapture = async () => {
    setCameraError('');
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: config.fps } },
        audio: false,
      });
      streamRef.current = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopCamera();
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setSourceMode('screen');
      setFramesSent(0);
      onCameraActiveChange(true, 'Захват экрана');
      startProcessorLoop('screen');
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Захват экрана отменён или недоступен в этом браузере.';
      setCameraError(msg);
      stopCamera();
    }
  };

  const startDemoCamera = () => {
    setCameraError('');
    stopCamera();
    setSourceMode('demo');
    setFramesSent(0);
    setActualResolution('960 × 540');
    onCameraActiveChange(true, 'Студийная демо-камера');
    startProcessorLoop('demo');
  };

  const activeFilterMeta =
    CAMERA_FILTERS.find((f) => f.id === config.filter) || CAMERA_FILTERS[0];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Live Camera Preview & Frame Processor Stage */}
        <section className="xl:col-span-7 bg-[#121620] border border-white/[0.08] rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[#F1F5F9]">
                Студийный монитор камеры (Vision Camera)
              </h2>
              <p className="text-xs text-[#8B95A7] mt-0.5">
                Захват веб-камеры, OBS Virtual Camera или экрана с обработкой кадров в реальном времени
              </p>
            </div>
            <div className="text-xs font-mono tabular-nums text-[#94A3B8]">
              {sourceMode === 'off'
                ? 'Сигнал выключен'
                : `${actualResolution} · ${config.fps} FPS`}
            </div>
          </div>

          {/* Hidden raw video element fed into Frame Processor Canvas */}
          <video ref={videoRef} playsInline muted className="hidden" />

          {/* Live Canvas Preview */}
          <div className="relative aspect-video w-full rounded-md overflow-hidden bg-[#090C12] border border-white/[0.1] flex items-center justify-center">
            <canvas
              ref={canvasRef}
              className={`w-full h-full object-contain ${
                sourceMode === 'off' ? 'hidden' : 'block'
              }`}
            />

            {sourceMode === 'off' && (
              <div className="text-center px-6 py-8 max-w-md space-y-3">
                <CameraOff className="w-8 h-8 text-[#475569] mx-auto" />
                <div className="text-sm font-medium text-[#E6ECF5]">
                  Камера не активна
                </div>
                <p className="text-xs text-[#8B95A7] leading-relaxed">
                  Подключите физическую камеру, OBS Virtual Camera, захват окна трансляции или запустите тестовую студийную камеру для проверки фильтров и Vision-контекста.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void startWebcam()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-semibold bg-[#E11D48] hover:bg-[#BE123C] text-white transition-colors"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    Включить камеру
                  </button>
                  <button
                    type="button"
                    onClick={startDemoCamera}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08] transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Демо-камера
                  </button>
                </div>
              </div>
            )}

            {sourceMode !== 'off' && (
              <div className="absolute top-3 left-3 flex items-center gap-2 bg-[#0B0E14]/85 border border-white/[0.12] rounded px-2.5 py-1 text-[11px] font-mono text-[#F1F5F9]">
                <span className="w-2 h-2 rounded-full bg-[#E11D48] animate-pulse" />
                <span>
                  {sourceMode === 'webcam'
                    ? 'LIVE CAM'
                    : sourceMode === 'screen'
                      ? 'SCREEN'
                      : 'DEMO CAM'}
                </span>
                <span className="text-[#64748B]">|</span>
                <span className="text-[#94A3B8]">{activeFilterMeta.label}</span>
              </div>
            )}
          </div>

          {cameraError && (
            <p role="alert" className="text-xs text-[#FB7185]">
              {cameraError}
            </p>
          )}

          {/* Source Action Bar */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => void startWebcam()}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                sourceMode === 'webcam'
                  ? 'bg-[#E11D48] text-white'
                  : 'bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08]'
              }`}
            >
              <Camera className="w-3.5 h-3.5" />
              Веб-камера / OBS Virtual Cam
            </button>
            <button
              type="button"
              onClick={() => void startScreenCapture()}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                sourceMode === 'screen'
                  ? 'bg-[#E11D48] text-white'
                  : 'bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08]'
              }`}
            >
              <Monitor className="w-3.5 h-3.5" />
              Захват экрана
            </button>
            <button
              type="button"
              onClick={startDemoCamera}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                sourceMode === 'demo'
                  ? 'bg-[#E11D48] text-white'
                  : 'bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08]'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Демо-камера
            </button>
            {sourceMode !== 'off' && (
              <button
                type="button"
                onClick={stopCamera}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium bg-[#2A1219] hover:bg-[#3A1722] text-[#FECDD3] border border-[#E11D48]/40 transition-colors whitespace-nowrap ml-auto"
              >
                <CameraOff className="w-3.5 h-3.5" />
                Отключить
              </button>
            )}
          </div>
        </section>

        {/* Right: Device Selector, Frame Processor Filters & Gemini/OBS Routing */}
        <section className="xl:col-span-5 bg-[#121620] border border-white/[0.08] rounded-lg p-5 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-[#F1F5F9]">
              Настройки камеры и обработчика кадров
            </h2>
            <p className="text-xs text-[#8B95A7] mt-0.5">
              Параметры захвата, цветокоррекция в реальном времени и передача видеопотока в Gemini / OBS
            </p>
          </div>

          {/* Device selector */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="camera-device-select"
                className="text-xs text-[#8B95A7]"
              >
                Устройство видеозахвата
              </label>
              <button
                type="button"
                onClick={() => void refreshVideoDevices()}
                className="inline-flex items-center gap-1 text-[11px] text-[#94A3B8] hover:text-white"
              >
                <RefreshCw className="w-3 h-3" />
                Обновить список
              </button>
            </div>
            <select
              id="camera-device-select"
              value={config.deviceId}
              onChange={(e) =>
                onChangeConfig({ ...config, deviceId: e.target.value })
              }
              className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
            >
              <option value="">Камера по умолчанию (автовыбор)</option>
              {videoDevices.map((dev, idx) => (
                <option key={dev.deviceId || idx} value={dev.deviceId}>
                  {dev.label || `Видеоустройство ${idx + 1}`}
                </option>
              ))}
            </select>
          </div>

          {/* Resolution & FPS */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="camera-res-select"
                className="block text-xs text-[#8B95A7] mb-1.5"
              >
                Разрешение
              </label>
              <select
                id="camera-res-select"
                value={config.resolution}
                onChange={(e) =>
                  onChangeConfig({
                    ...config,
                    resolution: e.target.value as CameraConfig['resolution'],
                  })
                }
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs text-[#F1F5F9]"
              >
                {(
                  Object.keys(RESOLUTION_MAP) as CameraConfig['resolution'][]
                ).map((res) => (
                  <option key={res} value={res}>
                    {RESOLUTION_MAP[res].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="camera-fps-select"
                className="block text-xs text-[#8B95A7] mb-1.5"
              >
                Частота кадров
              </label>
              <select
                id="camera-fps-select"
                value={config.fps}
                onChange={(e) =>
                  onChangeConfig({
                    ...config,
                    fps: Number(e.target.value) as 30 | 60,
                  })
                }
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs font-mono text-[#F1F5F9]"
              >
                <option value={30}>30 FPS</option>
                <option value={60}>60 FPS</option>
              </select>
            </div>
          </div>

          {/* Frame Processor Filters */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-[#8B95A7]">
                Фильтр обработчика кадров (Frame Processor)
              </span>
              <button
                type="button"
                aria-pressed={config.mirror}
                onClick={() =>
                  onChangeConfig({ ...config, mirror: !config.mirror })
                }
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border transition-colors ${
                  config.mirror
                    ? 'bg-[#1D2434] border-[#E11D48] text-white'
                    : 'bg-[#0B0E14] border-white/[0.08] text-[#94A3B8] hover:text-white'
                }`}
              >
                <FlipHorizontal2 className="w-3 h-3" />
                Зеркало
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {CAMERA_FILTERS.map((f) => {
                const active = config.filter === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onChangeConfig({
                        ...config,
                        filter: f.id as CameraFilterMode,
                      })
                    }
                    className={`px-2.5 py-2 rounded text-xs font-medium text-left border transition-colors truncate ${
                      active
                        ? 'bg-[#1D2434] border-[#E11D48] text-white'
                        : 'bg-[#0B0E14] border-white/[0.06] text-[#94A3B8] hover:text-white'
                    }`}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Vision & OBS PiP Routing */}
          <div className="pt-4 border-t border-white/[0.06] space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <label
                  htmlFor="cam-vision-gemini-toggle"
                  className="text-xs font-medium text-[#E6ECF5] flex items-center gap-1.5"
                >
                  <Radio className="w-3.5 h-3.5 text-[#E11D48]" />
                  Передавать кадры в Gemini Vision (1 FPS)
                </label>
                <p className="text-[11px] text-[#8B95A7] mt-0.5">
                  Помогает переводчику и Gemini 3.8 Live Realtime точнее переводить слайды, экран и жесты ведущего
                </p>
              </div>
              <input
                id="cam-vision-gemini-toggle"
                type="checkbox"
                checked={config.sendVisionToGemini}
                onChange={(e) =>
                  onChangeConfig({
                    ...config,
                    sendVisionToGemini: e.target.checked,
                  })
                }
                className="w-4 h-4 accent-[#E11D48] cursor-pointer mt-0.5"
              />
            </div>

            <div className="flex items-start justify-between gap-3">
              <div>
                <label
                  htmlFor="cam-obs-pip-toggle"
                  className="text-xs font-medium text-[#E6ECF5] flex items-center gap-1.5"
                >
                  <Tv className="w-3.5 h-3.5 text-[#38BDF8]" />
                  Транслировать мини-окно камеры в OBS Overlay (PiP)
                </label>
                <p className="text-[11px] text-[#8B95A7] mt-0.5">
                  Выводит обработанный кадр камеры в Browser Source OBS поверх сцены (1 кадр/сек)
                </p>
              </div>
              <input
                id="cam-obs-pip-toggle"
                type="checkbox"
                checked={config.sendVideoToObs}
                onChange={(e) =>
                  onChangeConfig({
                    ...config,
                    sendVideoToObs: e.target.checked,
                  })
                }
                className="w-4 h-4 accent-[#E11D48] cursor-pointer mt-0.5"
              />
            </div>

            <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-[11px] font-mono tabular-nums text-[#8B95A7]">
              <span>
                Статус Vision:{' '}
                {sourceMode !== 'off' && config.sendVisionToGemini
                  ? isLive
                    ? 'Стриминг в Live API'
                    : 'Буфер контекста готов'
                  : 'Ожидание камеры'}
              </span>
              <span>Кадров: {framesSent}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
