import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CameraOff,
  Film,
  FlipHorizontal2,
  Monitor,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Repeat,
  RotateCcw,
  ScanFace,
  Sparkles,
  Tv,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { CAMERA_FILTERS, FACE_MASK_PRESETS } from '../constants/presets';
import type {
  CameraConfig,
  CameraFilterMode,
  FaceMaskType,
} from '../types/translator';
import {
  DEFAULT_CENTER_FACE,
  detectFaceFromRgba,
  formatMediaTime,
  renderFaceMaskOnCanvas,
  smoothFaceBox,
  type NormalizedFaceBox,
} from '../utils/faceMaskEngine';

type CameraSourceMode = 'off' | 'webcam' | 'screen' | 'video' | 'demo';

interface BrowserFaceDetectorLike {
  detect(
    image: CanvasImageSource,
  ): Promise<Array<{ boundingBox: DOMRectReadOnly }>>;
}

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

  // Uploaded Video File playback state
  const [videoFileName, setVideoFileName] = useState('');
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoMuted, setVideoMuted] = useState(false);
  const [videoLoop, setVideoLoop] = useState(true);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);

  // Face Mask state
  const [customMaskName, setCustomMaskName] = useState('');
  const [faceTrackingState, setFaceTrackingState] = useState<
    'idle' | 'detected' | 'manual'
  >('idle');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const visionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const detectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixelHelperCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoObjectUrlRef = useRef<string | null>(null);
  const customMaskImgRef = useRef<HTMLImageElement | null>(null);
  const customMaskObjectUrlRef = useRef<string | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const maskInputRef = useRef<HTMLInputElement | null>(null);

  const rafRef = useRef<number | null>(null);
  const visionTimerRef = useRef<number | null>(null);
  const trackedFaceRef = useRef<NormalizedFaceBox | null>(null);
  const manualFaceRef = useRef<NormalizedFaceBox>({ ...DEFAULT_CENTER_FACE });
  const isDraggingMaskRef = useRef(false);
  const lastDetectTsRef = useRef(0);
  const nativeDetectorRef = useRef<BrowserFaceDetectorLike | null>(null);
  const nativeDetectBusyRef = useRef(false);

  const configRef = useRef(config);
  configRef.current = config;

  // Probe optional native Chrome/Edge FaceDetector API once
  useEffect(() => {
    const win = window as unknown as {
      FaceDetector?: new (opts?: {
        fastMode?: boolean;
        maxDetectedFaces?: number;
      }) => BrowserFaceDetectorLike;
    };
    if (typeof win.FaceDetector === 'function') {
      try {
        nativeDetectorRef.current = new win.FaceDetector({
          fastMode: true,
          maxDetectedFaces: 1,
        });
      } catch {
        nativeDetectorRef.current = null;
      }
    }
  }, []);

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
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
    if (videoObjectUrlRef.current) {
      URL.revokeObjectURL(videoObjectUrlRef.current);
      videoObjectUrlRef.current = null;
    }
    trackedFaceRef.current = null;
    setSourceMode('off');
    setVideoFileName('');
    setVideoPlaying(false);
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setActualResolution('—');
    setFaceTrackingState('idle');
    onCameraActiveChange(false, 'Выключена');
  }, [onCameraActiveChange]);

  useEffect(() => {
    return () => {
      stopCamera();
      if (customMaskObjectUrlRef.current) {
        URL.revokeObjectURL(customMaskObjectUrlRef.current);
      }
    };
  }, [stopCamera]);

  // Real-time Canvas Frame Processor + Face Mask Tracker loop
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
        showPresenterForMask: boolean,
      ): NormalizedFaceBox => {
        const t = tMs / 1000;
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

        // Subtle studio wave backdrop
        ctx.save();
        ctx.strokeStyle = showPresenterForMask
          ? 'rgba(225, 29, 72, 0.45)'
          : '#E11D48';
        ctx.lineWidth = 3;
        ctx.beginPath();
        const midY = h * 0.56;
        for (let x = 40; x <= w - 40; x += 6) {
          const norm = (x - 40) / (w - 80);
          const env = Math.sin(norm * Math.PI);
          const y =
            midY +
            Math.sin(norm * 16 + t * 3.8) * 32 * env +
            Math.cos(norm * 28 - t * 2.4) * 12 * env;
          if (x === 40) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 40; x <= w - 40; x += 6) {
          const norm = (x - 40) / (w - 80);
          const env = Math.sin(norm * Math.PI);
          const y =
            midY +
            Math.sin(norm * 12 - t * 2.9 + 1.1) * 24 * env +
            Math.sin(norm * 22 + t * 4.2) * 8 * env;
          if (x === 40) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();

        // Presenter anchor with gentle natural studio head sway
        const headCxNorm = 0.5 + Math.sin(t * 1.15) * 0.035;
        const headCyNorm = 0.43 + Math.cos(t * 1.6) * 0.014;
        const headW = 0.21;
        const headH = 0.41;

        if (showPresenterForMask) {
          const hx = headCxNorm * w;
          const hy = headCyNorm * h;
          const rx = (headW * w) / 2;
          const ry = (headH * h) / 2;

          // Shoulders silhouette
          ctx.fillStyle = '#1C2436';
          ctx.beginPath();
          ctx.ellipse(hx, hy + ry * 2.05, rx * 2.1, ry * 1.25, 0, Math.PI, Math.PI * 2);
          ctx.fill();

          // Neck
          ctx.fillStyle = '#CFA187';
          ctx.fillRect(hx - rx * 0.34, hy + ry * 0.72, rx * 0.68, ry * 0.48);

          // Studio portrait head oval (skin-toned so face masks & blur/pixelation preview realistically!)
          const faceGrad = ctx.createRadialGradient(
            hx - rx * 0.2,
            hy - ry * 0.2,
            rx * 0.15,
            hx,
            hy,
            ry * 1.05,
          );
          faceGrad.addColorStop(0, '#E8BEA5');
          faceGrad.addColorStop(0.75, '#CF9B7E');
          faceGrad.addColorStop(1, '#A9765B');
          ctx.fillStyle = faceGrad;
          ctx.beginPath();
          ctx.ellipse(hx, hy, rx, ry, 0, 0, Math.PI * 2);
          ctx.fill();

          // Subtle facial features (eyes + nose + mouth) so blur/visor/glasses look clear
          ctx.fillStyle = '#1E293B';
          ctx.beginPath();
          ctx.ellipse(hx - rx * 0.34, hy - ry * 0.12, rx * 0.11, ry * 0.06, 0, 0, Math.PI * 2);
          ctx.ellipse(hx + rx * 0.34, hy - ry * 0.12, rx * 0.11, ry * 0.06, 0, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = 'rgba(92, 56, 42, 0.55)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(hx, hy - ry * 0.04);
          ctx.lineTo(hx - rx * 0.06, hy + ry * 0.2);
          ctx.lineTo(hx + rx * 0.06, hy + ry * 0.2);
          ctx.stroke();

          ctx.strokeStyle = '#7C3A32';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(hx, hy + ry * 0.34, rx * 0.26, 0.15 * Math.PI, 0.85 * Math.PI);
          ctx.stroke();
        }

        // Broadcast safe-area reticle
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(w * 0.08, h * 0.1, w * 0.84, h * 0.8);

        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const tc = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}:${pad(Math.floor((now.getMilliseconds() / 1000) * 30))}`;

        ctx.fillStyle = '#F8FAFC';
        ctx.font = `600 ${Math.round(h * 0.042)}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText('CAM 01 · DUBCAST VISION STUDIO', 36, h * 0.2);

        ctx.fillStyle = '#94A3B8';
        ctx.font = `500 ${Math.round(h * 0.026)}px "JetBrains Mono", monospace`;
        ctx.fillText(`TC ${tc}   ·   ${w}×${h}   ·   VISION 1 FPS`, 36, h * 0.25);

        ctx.fillStyle = 'rgba(11, 14, 20, 0.82)';
        ctx.fillRect(32, h - 64, w - 64, 38);
        ctx.fillStyle = '#E11D48';
        ctx.beginPath();
        ctx.arc(54, h - 45, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#E6ECF5';
        ctx.font = `500 ${Math.round(h * 0.024)}px "JetBrains Mono", monospace`;
        ctx.fillText(
          'ТЕСТОВЫЙ ВИДЕОПОТОК · ФИЛЬТРЫ, МАСКИ ЛИЦА И GEMINI VISION АКТИВНЫ',
          72,
          h - 39,
        );

        return {
          cx: headCxNorm,
          cy: headCyNorm,
          w: headW,
          h: headH,
          confidence: 1,
        };
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
        if (
          mode !== 'demo' &&
          video &&
          video.videoWidth > 0 &&
          video.videoHeight > 0
        ) {
          targetW = Math.min(1280, video.videoWidth);
          targetH = Math.round(
            (targetW * video.videoHeight) / video.videoWidth,
          );
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

        let demoFaceBox: NormalizedFaceBox | null = null;
        if (mode === 'demo') {
          demoFaceBox = drawDemoFrame(
            ctx,
            targetW,
            targetH,
            timestamp,
            curCfg.faceMask !== 'none',
          );
        } else if (video && video.readyState >= 2) {
          ctx.drawImage(video, 0, 0, targetW, targetH);
        }
        ctx.restore();

        // Optional cinematic vignette overlay
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

        // Real-time Face Tracking + Mask Rendering (works on Webcam, Uploaded Video, Screen & Demo!)
        if (curCfg.faceMask !== 'none') {
          let activeBox: NormalizedFaceBox = manualFaceRef.current;

          if (curCfg.faceMaskAutoTrack) {
            if (mode === 'demo' && demoFaceBox) {
              const mirroredCx = curCfg.mirror
                ? 1 - demoFaceBox.cx
                : demoFaceBox.cx;
              trackedFaceRef.current = smoothFaceBox(
                trackedFaceRef.current,
                { ...demoFaceBox, cx: mirroredCx },
                0.35,
              );
              activeBox = trackedFaceRef.current;
              setFaceTrackingState((prev) =>
                prev === 'detected' ? prev : 'detected',
              );
            } else {
              // Run lightweight face detection at ~14 Hz
              if (timestamp - lastDetectTsRef.current > 70) {
                lastDetectTsRef.current = timestamp;
                const nativeDet = nativeDetectorRef.current;
                if (nativeDet && !nativeDetectBusyRef.current) {
                  nativeDetectBusyRef.current = true;
                  void nativeDet
                    .detect(canvas)
                    .then((faces) => {
                      if (faces.length > 0 && canvas.width > 0 && canvas.height > 0) {
                        const bb = faces[0].boundingBox;
                        const box: NormalizedFaceBox = {
                          cx: (bb.x + bb.width / 2) / canvas.width,
                          cy: (bb.y + bb.height / 2) / canvas.height,
                          w: bb.width / canvas.width,
                          h: bb.height / canvas.height,
                          confidence: 1,
                        };
                        trackedFaceRef.current = smoothFaceBox(
                          trackedFaceRef.current,
                          box,
                          0.32,
                        );
                        setFaceTrackingState('detected');
                      } else {
                        // Fallback to YCbCr skin-blob tracker
                        runCvFallbackDetection(canvas);
                      }
                    })
                    .catch(() => {
                      runCvFallbackDetection(canvas);
                    })
                    .finally(() => {
                      nativeDetectBusyRef.current = false;
                    });
                } else {
                  runCvFallbackDetection(canvas);
                }
              }

              activeBox = trackedFaceRef.current || manualFaceRef.current;
            }
          } else {
            setFaceTrackingState((prev) =>
              prev === 'manual' ? prev : 'manual',
            );
          }

          if (!pixelHelperCanvasRef.current) {
            pixelHelperCanvasRef.current = document.createElement('canvas');
          }
          renderFaceMaskOnCanvas(
            ctx,
            canvas,
            activeBox,
            {
              type: curCfg.faceMask,
              scale: curCfg.faceMaskScale,
              offsetY: curCfg.faceMaskOffsetY,
              opacity: curCfg.faceMaskOpacity,
              customImage: customMaskImgRef.current,
            },
            pixelHelperCanvasRef.current,
          );
        }

        rafRef.current = requestAnimationFrame(renderFrame);
      };

      const runCvFallbackDetection = (srcCanvas: HTMLCanvasElement) => {
        if (!detectCanvasRef.current) {
          detectCanvasRef.current = document.createElement('canvas');
        }
        const dCanvas = detectCanvasRef.current;
        const dw = 96;
        const dh = 54;
        dCanvas.width = dw;
        dCanvas.height = dh;
        const dCtx = dCanvas.getContext('2d', { willReadFrequently: true });
        if (!dCtx) return;
        dCtx.drawImage(srcCanvas, 0, 0, dw, dh);
        const imgData = dCtx.getImageData(0, 0, dw, dh);
        const detected = detectFaceFromRgba(imgData.data, dw, dh);
        if (detected) {
          trackedFaceRef.current = smoothFaceBox(
            trackedFaceRef.current,
            detected,
            0.25,
          );
          setFaceTrackingState((prev) =>
            prev === 'detected' ? prev : 'detected',
          );
        }
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
        videoRef.current.muted = true;
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
          : 'Не удалось получить доступ к камере. Проверьте разрешения браузера, загрузите видеофайл или включите «Демо-камеру».';
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
        videoRef.current.muted = true;
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

  const handleVideoFileSelected = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setCameraError('');
    stopCamera();

    try {
      const objectUrl = URL.createObjectURL(file);
      videoObjectUrlRef.current = objectUrl;

      const video = videoRef.current;
      if (!video) return;

      video.srcObject = null;
      video.src = objectUrl;
      video.loop = videoLoop;
      video.muted = videoMuted;
      video.playsInline = true;

      await new Promise<void>((resolve, reject) => {
        const onLoaded = () => {
          cleanup();
          resolve();
        };
        const onErr = () => {
          cleanup();
          reject(
            new Error(
              'Не удалось декодировать видеофайл. Используйте MP4, WebM или MOV.',
            ),
          );
        };
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', onLoaded);
          video.removeEventListener('error', onErr);
        };
        video.addEventListener('loadedmetadata', onLoaded);
        video.addEventListener('error', onErr);
      });

      setVideoDuration(video.duration || 0);
      setVideoCurrentTime(0);
      setVideoFileName(file.name);
      await video.play();
      setVideoPlaying(true);
      setSourceMode('video');
      setFramesSent(0);
      onCameraActiveChange(true, `Видео: ${file.name}`);
      startProcessorLoop('video');
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Ошибка загрузки видеофайла.';
      setCameraError(msg);
      stopCamera();
    }
  };

  const handleCustomMaskSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (customMaskObjectUrlRef.current) {
      URL.revokeObjectURL(customMaskObjectUrlRef.current);
    }
    const url = URL.createObjectURL(file);
    customMaskObjectUrlRef.current = url;
    const img = new Image();
    img.onload = () => {
      customMaskImgRef.current = img;
      setCustomMaskName(file.name);
      onChangeConfig({ ...config, faceMask: 'custom_png' });
    };
    img.onerror = () => {
      setCameraError('Не удалось загрузить файл маски. Используйте PNG или WebP.');
    };
    img.src = url;
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

  // Interactive click/drag on the monitor canvas to position face mask manually
  const updateManualMaskPosition = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (config.faceMask === 'none') return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = Math.max(0.08, Math.min(0.92, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0.08, Math.min(0.92, (e.clientY - rect.top) / rect.height));
    manualFaceRef.current = {
      ...manualFaceRef.current,
      cx: nx,
      cy: ny,
    };
    trackedFaceRef.current = { ...manualFaceRef.current };
    if (config.faceMaskAutoTrack) {
      onChangeConfig({ ...config, faceMaskAutoTrack: false });
    }
    setFaceTrackingState('manual');
  };

  const toggleVideoPlayPause = () => {
    const video = videoRef.current;
    if (!video || sourceMode !== 'video') return;
    if (video.paused) {
      void video.play();
      setVideoPlaying(true);
    } else {
      video.pause();
      setVideoPlaying(false);
    }
  };

  const handleVideoSeek = (sec: number) => {
    const video = videoRef.current;
    if (!video || sourceMode !== 'video') return;
    video.currentTime = sec;
    setVideoCurrentTime(sec);
  };

  const activeFilterMeta =
    CAMERA_FILTERS.find((f) => f.id === config.filter) || CAMERA_FILTERS[0];
  const activeMaskMeta =
    FACE_MASK_PRESETS.find((m) => m.id === config.faceMask) ||
    FACE_MASK_PRESETS[0];

  return (
    <div className="space-y-6">
      {/* Hidden file inputs */}
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        onChange={(e) => void handleVideoFileSelected(e)}
        className="hidden"
      />
      <input
        ref={maskInputRef}
        type="file"
        accept="image/png,image/webp,image/svg+xml,image/jpeg"
        onChange={handleCustomMaskSelected}
        className="hidden"
      />

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Live Camera / Video Preview & Frame Processor Stage */}
        <section className="xl:col-span-7 bg-[#121620] border border-white/[0.08] rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[#F1F5F9]">
                Студийный монитор камеры и видео (Vision Camera)
              </h2>
              <p className="text-xs text-[#8B95A7] mt-0.5">
                Веб-камера, OBS Virtual Camera, видеофайл или экран с фильтрами и масками лица в реальном времени
              </p>
            </div>
            <div className="text-xs font-mono tabular-nums text-[#94A3B8]">
              {sourceMode === 'off'
                ? 'Сигнал выключен'
                : `${actualResolution} · ${config.fps} FPS`}
            </div>
          </div>

          {/* Hidden video element fed into Frame Processor Canvas */}
          <video
            ref={videoRef}
            playsInline
            muted={sourceMode !== 'video' || videoMuted}
            loop={sourceMode === 'video' ? videoLoop : false}
            onTimeUpdate={() => {
              if (sourceMode === 'video' && videoRef.current) {
                setVideoCurrentTime(videoRef.current.currentTime);
              }
            }}
            onEnded={() => {
              if (sourceMode === 'video' && !videoLoop) {
                setVideoPlaying(false);
              }
            }}
            className="hidden"
          />

          {/* Live Canvas Preview */}
          <div className="relative aspect-video w-full rounded-md overflow-hidden bg-[#090C12] border border-white/[0.1] flex items-center justify-center">
            <canvas
              ref={canvasRef}
              onPointerDown={(e) => {
                if (config.faceMask !== 'none') {
                  isDraggingMaskRef.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  updateManualMaskPosition(e);
                }
              }}
              onPointerMove={(e) => {
                if (isDraggingMaskRef.current && config.faceMask !== 'none') {
                  updateManualMaskPosition(e);
                }
              }}
              onPointerUp={(e) => {
                if (isDraggingMaskRef.current) {
                  isDraggingMaskRef.current = false;
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }
              }}
              className={`w-full h-full object-contain ${
                config.faceMask !== 'none' ? 'cursor-crosshair' : ''
              } ${sourceMode === 'off' ? 'hidden' : 'block'}`}
            />

            {sourceMode === 'off' && (
              <div className="text-center px-6 py-8 max-w-lg space-y-3">
                <CameraOff className="w-8 h-8 text-[#475569] mx-auto" />
                <div className="text-sm font-medium text-[#E6ECF5]">
                  Источник видео не выбран
                </div>
                <p className="text-xs text-[#8B95A7] leading-relaxed">
                  Подключите веб-камеру, OBS Virtual Camera, загрузите видеофайл (MP4 / WebM / MOV) или включите студийную демо-камеру для проверки фильтров и масок лица.
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
                    onClick={() => videoInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08] transition-colors"
                  >
                    <Film className="w-3.5 h-3.5" />
                    Загрузить видео
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
              <div className="absolute top-3 left-3 flex items-center gap-2 bg-[#0B0E14]/85 border border-white/[0.12] rounded px-2.5 py-1 text-[11px] font-mono text-[#F1F5F9] pointer-events-none">
                <span className="w-2 h-2 rounded-full bg-[#E11D48] animate-pulse" />
                <span>
                  {sourceMode === 'webcam'
                    ? 'LIVE CAM'
                    : sourceMode === 'video'
                      ? 'VIDEO'
                      : sourceMode === 'screen'
                        ? 'SCREEN'
                        : 'DEMO CAM'}
                </span>
                <span className="text-[#64748B]">|</span>
                <span className="text-[#94A3B8]">{activeFilterMeta.label}</span>
                {config.faceMask !== 'none' && (
                  <>
                    <span className="text-[#64748B]">|</span>
                    <span className="text-[#38BDF8]">{activeMaskMeta.label}</span>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Uploaded Video Playback Bar */}
          {sourceMode === 'video' && (
            <div className="bg-[#0B0E14] border border-white/[0.08] rounded-md px-3.5 py-2.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={toggleVideoPlayPause}
                    aria-label={videoPlaying ? 'Пауза' : 'Воспроизвести'}
                    className="inline-flex items-center justify-center w-7 h-7 rounded bg-[#1C2230] hover:bg-[#252D40] text-white border border-white/[0.08] shrink-0"
                  >
                    {videoPlaying ? (
                      <Pause className="w-3.5 h-3.5" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <span className="text-[#E6ECF5] font-medium truncate">
                    {videoFileName}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono tabular-nums text-[11px] text-[#94A3B8]">
                    {formatMediaTime(videoCurrentTime)} /{' '}
                    {formatMediaTime(videoDuration)}
                  </span>
                  <button
                    type="button"
                    aria-pressed={videoLoop}
                    onClick={() => {
                      const next = !videoLoop;
                      setVideoLoop(next);
                      if (videoRef.current) videoRef.current.loop = next;
                    }}
                    title="Зациклить видео"
                    className={`p-1.5 rounded border text-xs ${
                      videoLoop
                        ? 'bg-[#1D2434] border-[#E11D48] text-white'
                        : 'bg-[#121620] border-white/[0.08] text-[#8B95A7]'
                    }`}
                  >
                    <Repeat className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-pressed={!videoMuted}
                    onClick={() => {
                      const next = !videoMuted;
                      setVideoMuted(next);
                      if (videoRef.current) videoRef.current.muted = next;
                    }}
                    title={videoMuted ? 'Включить звук видео' : 'Выключить звук видео'}
                    className="p-1.5 rounded bg-[#121620] border border-white/[0.08] text-[#CBD5E1] hover:text-white"
                  >
                    {videoMuted ? (
                      <VolumeX className="w-3.5 h-3.5 text-[#FB7185]" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5 text-[#34D399]" />
                    )}
                  </button>
                </div>
              </div>
              <input
                type="range"
                aria-label="Позиция воспроизведения видео"
                min={0}
                max={Math.max(0.1, videoDuration)}
                step={0.1}
                value={Math.min(videoCurrentTime, videoDuration || 0)}
                onChange={(e) => handleVideoSeek(Number(e.target.value))}
                className="studio-fader w-full"
              />
            </div>
          )}

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
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                sourceMode === 'webcam'
                  ? 'bg-[#E11D48] text-white'
                  : 'bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08]'
              }`}
            >
              <Camera className="w-3.5 h-3.5" />
              Камера / Virtual Cam
            </button>
            <button
              type="button"
              onClick={() => videoInputRef.current?.click()}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                sourceMode === 'video'
                  ? 'bg-[#E11D48] text-white'
                  : 'bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08]'
              }`}
            >
              <Film className="w-3.5 h-3.5" />
              Видеофайл
            </button>
            <button
              type="button"
              onClick={() => void startScreenCapture()}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                sourceMode === 'screen'
                  ? 'bg-[#E11D48] text-white'
                  : 'bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08]'
              }`}
            >
              <Monitor className="w-3.5 h-3.5" />
              Экран
            </button>
            <button
              type="button"
              onClick={startDemoCamera}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
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
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium bg-[#2A1219] hover:bg-[#3A1722] text-[#FECDD3] border border-[#E11D48]/40 transition-colors whitespace-nowrap ml-auto"
              >
                <CameraOff className="w-3.5 h-3.5" />
                Отключить
              </button>
            )}
          </div>
        </section>

        {/* Right: Face Masks, Device Selector, Frame Processor Filters & Gemini/OBS Routing */}
        <section className="xl:col-span-5 bg-[#121620] border border-white/[0.08] rounded-lg p-5 space-y-5">
          {/* Face Masks Section (works on both Live Camera & Uploaded Video!) */}
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-[#F1F5F9] flex items-center gap-1.5">
                  <ScanFace className="w-4 h-4 text-[#E11D48]" />
                  Маски на лицо (камера и видео)
                </h2>
                <p className="text-xs text-[#8B95A7] mt-0.5">
                  {activeMaskMeta.hint}
                </p>
              </div>
              {config.faceMask !== 'none' && (
                <span className="text-[11px] font-mono text-[#38BDF8] whitespace-nowrap">
                  {faceTrackingState === 'detected'
                    ? 'Лицо найдено'
                    : faceTrackingState === 'manual'
                      ? 'Ручная позиция'
                      : 'Поиск лица…'}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-2 gap-1.5">
              {FACE_MASK_PRESETS.map((mask) => {
                const active = config.faceMask === mask.id;
                return (
                  <button
                    key={mask.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      if (mask.id === 'custom_png' && !customMaskImgRef.current) {
                        maskInputRef.current?.click();
                        return;
                      }
                      onChangeConfig({
                        ...config,
                        faceMask: mask.id as FaceMaskType,
                      });
                    }}
                    className={`px-2.5 py-2 rounded text-xs font-medium text-left border transition-colors truncate ${
                      active
                        ? 'bg-[#1D2434] border-[#E11D48] text-white'
                        : 'bg-[#0B0E14] border-white/[0.06] text-[#94A3B8] hover:text-white'
                    }`}
                  >
                    {mask.label}
                  </button>
                );
              })}
            </div>

            {config.faceMask !== 'none' && (
              <div className="pt-2 space-y-3 border-t border-white/[0.06]">
                {config.faceMask === 'custom_png' && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-[#94A3B8] truncate">
                      {customMaskName || 'Выберите PNG-маску с прозрачным фоном'}
                    </span>
                    <button
                      type="button"
                      onClick={() => maskInputRef.current?.click()}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-[#1C2230] hover:bg-[#252D40] text-white border border-white/[0.08] whitespace-nowrap shrink-0"
                    >
                      <Upload className="w-3 h-3" />
                      Загрузить PNG
                    </button>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="mask-autotrack-toggle"
                    className="text-xs text-[#CBD5E1]"
                  >
                    Авто-трекинг лица (или перетащите маску мышкой на кадре)
                  </label>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        manualFaceRef.current = { ...DEFAULT_CENTER_FACE };
                        trackedFaceRef.current = null;
                        onChangeConfig({
                          ...config,
                          faceMaskAutoTrack: true,
                          faceMaskScale: 1.0,
                          faceMaskOffsetY: 0,
                          faceMaskOpacity: 1.0,
                        });
                      }}
                      title="Сбросить позицию и размер маски"
                      className="p-1 rounded text-[#8B95A7] hover:text-white"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                    <input
                      id="mask-autotrack-toggle"
                      type="checkbox"
                      checked={config.faceMaskAutoTrack}
                      onChange={(e) =>
                        onChangeConfig({
                          ...config,
                          faceMaskAutoTrack: e.target.checked,
                        })
                      }
                      className="w-4 h-4 accent-[#E11D48] cursor-pointer"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <label htmlFor="mask-scale-slider" className="text-[#8B95A7]">
                        Размер
                      </label>
                      <span className="font-mono tabular-nums text-[#E6ECF5]">
                        {Math.round(config.faceMaskScale * 100)}%
                      </span>
                    </div>
                    <input
                      id="mask-scale-slider"
                      type="range"
                      min={0.5}
                      max={1.8}
                      step={0.05}
                      value={config.faceMaskScale}
                      onChange={(e) =>
                        onChangeConfig({
                          ...config,
                          faceMaskScale: Number(e.target.value),
                        })
                      }
                      className="studio-fader w-full"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <label htmlFor="mask-offsety-slider" className="text-[#8B95A7]">
                        Высота Y
                      </label>
                      <span className="font-mono tabular-nums text-[#E6ECF5]">
                        {config.faceMaskOffsetY > 0 ? '+' : ''}
                        {Math.round(config.faceMaskOffsetY * 100)}
                      </span>
                    </div>
                    <input
                      id="mask-offsety-slider"
                      type="range"
                      min={-0.4}
                      max={0.4}
                      step={0.02}
                      value={config.faceMaskOffsetY}
                      onChange={(e) =>
                        onChangeConfig({
                          ...config,
                          faceMaskOffsetY: Number(e.target.value),
                        })
                      }
                      className="studio-fader w-full"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <label htmlFor="mask-opacity-slider" className="text-[#8B95A7]">
                        Плотность
                      </label>
                      <span className="font-mono tabular-nums text-[#E6ECF5]">
                        {Math.round(config.faceMaskOpacity * 100)}%
                      </span>
                    </div>
                    <input
                      id="mask-opacity-slider"
                      type="range"
                      min={0.3}
                      max={1.0}
                      step={0.05}
                      value={config.faceMaskOpacity}
                      onChange={(e) =>
                        onChangeConfig({
                          ...config,
                          faceMaskOpacity: Number(e.target.value),
                        })
                      }
                      className="studio-fader w-full"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Device selector & Resolution */}
          <div className="pt-4 border-t border-white/[0.06] space-y-3">
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
                  Обновить
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
          </div>

          {/* Frame Processor Filters */}
          <div className="pt-4 border-t border-white/[0.06]">
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
                  Помогает переводчику и Gemini 3.8 Live Realtime точнее переводить видео и сцену
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
                  Транслировать мини-окно в OBS Overlay (PiP)
                </label>
                <p className="text-[11px] text-[#8B95A7] mt-0.5">
                  Выводит камеру или видео с наложенной маской в Browser Source OBS
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
                  : 'Ожидание источника'}
              </span>
              <span>Кадров: {framesSent}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
