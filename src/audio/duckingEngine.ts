import type { AudioLevels, DuckingConfig } from '../types/translator';
import {
  SILENCE_DB,
  base64ToUint8,
  computeGainReductionDb,
  computeRmsDb,
  computeTargetOriginalGain,
  dbToGain,
  float32ToPcm16Base64,
  pcm16Base64ToFloat32,
  resampleLinear,
} from '../utils/duckingMath';

type LevelListener = (levels: AudioLevels) => void;
type DuckStateListener = (state: {
  isDucking: boolean;
  isOriginalMuted: boolean;
  gainReductionDb: number;
}) => void;

/**
 * Web Audio Broadcast Ducking & Replacement Engine.
 * Routes original audio (live mic/virtual cable, uploaded file, or DSP demo bed)
 * through a real-time GainNode automated by Gemini 3.8 Flash TTS speech activity.
 */
export class BroadcastDuckingEngine {
  private ctx: AudioContext | null = null;
  private sourceGainNode: GainNode | null = null;
  private monitorGateNode: GainNode | null = null;
  private ttsGainNode: GainNode | null = null;
  private masterGainNode: GainNode | null = null;

  private preOriginalAnalyser: AnalyserNode | null = null;
  private postOriginalAnalyser: AnalyserNode | null = null;
  private ttsAnalyser: AnalyserNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;

  private micStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private captureProcessor: ScriptProcessorNode | null = null;
  private captureSilenceGain: GainNode | null = null;

  private clipSourceNode: AudioBufferSourceNode | null = null;
  private demoOscNodes: OscillatorNode[] = [];
  private demoGainNode: GainNode | null = null;

  private activeTtsSources = new Set<AudioBufferSourceNode>();
  private nextPcmStartTime = 0;
  private releaseTimer: number | null = null;
  private rafId: number | null = null;

  private config: DuckingConfig;
  private isLiveArmed = false;
  private isTtsSpeaking = false;
  private monitorOriginal = false;
  private lastDuckNotify = { isDucking: false, isOriginalMuted: false };

  private levelListeners = new Set<LevelListener>();
  private duckStateListeners = new Set<DuckStateListener>();

  private preBuf = new Float32Array(512);
  private postBuf = new Float32Array(512);
  private ttsBuf = new Float32Array(512);
  private masterBuf = new Float32Array(512);

  constructor(initialConfig: DuckingConfig) {
    this.config = { ...initialConfig };
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new AudioCtx();

      this.preOriginalAnalyser = this.ctx.createAnalyser();
      this.preOriginalAnalyser.fftSize = 512;

      this.sourceGainNode = this.ctx.createGain();
      this.sourceGainNode.gain.value = dbToGain(this.config.originalGainDb);

      this.postOriginalAnalyser = this.ctx.createAnalyser();
      this.postOriginalAnalyser.fftSize = 512;

      // Monitor gate prevents acoustic mic feedback unless explicitly enabled
      this.monitorGateNode = this.ctx.createGain();
      this.monitorGateNode.gain.value = this.monitorOriginal ? 1 : 0;

      this.ttsGainNode = this.ctx.createGain();
      this.ttsGainNode.gain.value = dbToGain(this.config.ttsGainDb);

      this.ttsAnalyser = this.ctx.createAnalyser();
      this.ttsAnalyser.fftSize = 512;

      this.masterGainNode = this.ctx.createGain();
      this.masterGainNode.gain.value = 1;

      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 512;

      // Original chain: preOriginalAnalyser -> sourceGainNode -> postOriginalAnalyser -> monitorGateNode -> masterGainNode
      this.preOriginalAnalyser.connect(this.sourceGainNode);
      this.sourceGainNode.connect(this.postOriginalAnalyser);
      this.postOriginalAnalyser.connect(this.monitorGateNode);
      this.monitorGateNode.connect(this.masterGainNode);

      // TTS chain: ttsGainNode -> ttsAnalyser -> masterGainNode -> masterAnalyser -> destination
      this.ttsGainNode.connect(this.ttsAnalyser);
      this.ttsAnalyser.connect(this.masterGainNode);
      this.masterGainNode.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);

      this.startMeterLoop();
    }

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public subscribeLevels(listener: LevelListener): () => void {
    this.levelListeners.add(listener);
    return () => {
      this.levelListeners.delete(listener);
    };
  }

  public subscribeDuckState(listener: DuckStateListener): () => void {
    this.duckStateListeners.add(listener);
    return () => {
      this.duckStateListeners.delete(listener);
    };
  }

  public updateConfig(next: DuckingConfig): void {
    this.config = { ...next };
    if (this.ctx && this.ttsGainNode) {
      const now = this.ctx.currentTime;
      this.ttsGainNode.gain.setTargetAtTime(dbToGain(next.ttsGainDb), now, 0.02);
    }
    this.applyDuckingRamp(this.isTtsSpeaking);
  }

  public setLiveArmed(armed: boolean): void {
    this.isLiveArmed = armed;
    this.applyDuckingRamp(this.isTtsSpeaking);
  }

  public setMonitorOriginal(enabled: boolean): void {
    this.monitorOriginal = enabled;
    if (this.ctx && this.monitorGateNode) {
      this.monitorGateNode.gain.setTargetAtTime(
        enabled ? 1 : 0,
        this.ctx.currentTime,
        0.02,
      );
    }
  }

  private applyDuckingRamp(speaking: boolean): void {
    const targetGain = computeTargetOriginalGain(
      this.config,
      speaking,
      this.isLiveArmed,
    );
    const nominalGain = dbToGain(this.config.originalGainDb);
    const reductionDb = computeGainReductionDb(nominalGain, targetGain);
    const isOriginalMuted = targetGain <= 0.0001;
    const isDucking = reductionDb < -0.5;

    if (this.ctx && this.sourceGainNode) {
      const now = this.ctx.currentTime;
      const rampSec = Math.max(
        0.008,
        (speaking ? this.config.attackMs : this.config.releaseMs) / 1000,
      );
      this.sourceGainNode.gain.cancelScheduledValues(now);
      this.sourceGainNode.gain.setValueAtTime(this.sourceGainNode.gain.value, now);
      this.sourceGainNode.gain.linearRampToValueAtTime(targetGain, now + rampSec);
    }

    if (
      isDucking !== this.lastDuckNotify.isDucking ||
      isOriginalMuted !== this.lastDuckNotify.isOriginalMuted
    ) {
      this.lastDuckNotify = { isDucking, isOriginalMuted };
      for (const listener of this.duckStateListeners) {
        listener({ isDucking, isOriginalMuted, gainReductionDb: reductionDb });
      }
    }
  }

  private markTtsActivityStart(): void {
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (!this.isTtsSpeaking) {
      this.isTtsSpeaking = true;
      this.applyDuckingRamp(true);
    }
  }

  private scheduleTtsActivityRelease(): void {
    if (this.activeTtsSources.size > 0) return;
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
    }
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = null;
      if (this.activeTtsSources.size === 0) {
        this.isTtsSpeaking = false;
        this.applyDuckingRamp(false);
      }
    }, Math.max(40, this.config.holdMs));
  }

  /**
   * Starts capturing live microphone / virtual audio cable input, routing it
   * into the ducking chain AND emitting 16kHz PCM16 base64 chunks for Gemini Live Transcription.
   */
  public async startMicCapture(
    deviceId: string | undefined,
    onPcm16kChunk: (base64Pcm: string) => void,
  ): Promise<void> {
    this.stopMicCapture();
    const ctx = this.ensureContext();

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.micStream = stream;
    this.micSourceNode = ctx.createMediaStreamSource(stream);

    // Feed pre-fader analyser -> ducking processor
    if (this.preOriginalAnalyser) {
      this.micSourceNode.connect(this.preOriginalAnalyser);
    }

    // Parallel tap for 16kHz PCM streaming to Gemini Live Transcribe
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const silence = ctx.createGain();
    silence.gain.value = 0;

    processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      const resampled = resampleLinear(channel, ctx.sampleRate, 16000);
      const b64 = float32ToPcm16Base64(resampled);
      onPcm16kChunk(b64);
    };

    this.micSourceNode.connect(processor);
    processor.connect(silence);
    silence.connect(ctx.destination);

    this.captureProcessor = processor;
    this.captureSilenceGain = silence;
    this.setLiveArmed(true);
  }

  public stopMicCapture(): void {
    if (this.captureProcessor) {
      this.captureProcessor.onaudioprocess = null;
      this.captureProcessor.disconnect();
      this.captureProcessor = null;
    }
    if (this.captureSilenceGain) {
      this.captureSilenceGain.disconnect();
      this.captureSilenceGain = null;
    }
    if (this.micSourceNode) {
      this.micSourceNode.disconnect();
      this.micSourceNode = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        track.stop();
      }
      this.micStream = null;
    }
    this.setLiveArmed(false);
  }

  /**
   * Plays a complete WAV file (returned by unary gemini-3.8-flash-tts) through
   * the TTS channel, triggering original audio ducking/muting automatically.
   */
  public async playWavBase64(base64Wav: string): Promise<void> {
    const ctx = this.ensureContext();
    const bytes = base64ToUint8(base64Wav);
    const arrayBuf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(arrayBuf).set(bytes);
    const audioBuffer = await ctx.decodeAudioData(arrayBuf);

    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      if (this.ttsGainNode) {
        source.connect(this.ttsGainNode);
      }

      this.activeTtsSources.add(source);
      this.markTtsActivityStart();

      const startAt = Math.max(ctx.currentTime + 0.015, this.nextPcmStartTime);
      this.nextPcmStartTime = startAt + audioBuffer.duration;

      source.onended = () => {
        this.activeTtsSources.delete(source);
        this.scheduleTtsActivityRelease();
        resolve();
      };

      source.start(startAt);
    });
  }

  /**
   * Enqueues a 24kHz raw L16 PCM chunk (from streaming gemini-3.8-flash-tts)
   * for gapless progressive playback and immediately engages original audio muting/ducking.
   */
  public enqueuePcm24kBase64(base64Pcm: string): void {
    const ctx = this.ensureContext();
    const decoded = pcm16Base64ToFloat32(base64Pcm);
    if (decoded.length === 0) return;

    const samples = new Float32Array(new ArrayBuffer(decoded.byteLength));
    samples.set(decoded);
    const audioBuffer = ctx.createBuffer(1, samples.length, 24000);
    audioBuffer.copyToChannel(samples, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    if (this.ttsGainNode) {
      source.connect(this.ttsGainNode);
    }

    this.activeTtsSources.add(source);
    this.markTtsActivityStart();

    const startAt = Math.max(ctx.currentTime + 0.02, this.nextPcmStartTime);
    this.nextPcmStartTime = startAt + audioBuffer.duration;

    source.onended = () => {
      this.activeTtsSources.delete(source);
      this.scheduleTtsActivityRelease();
    };

    source.start(startAt);
  }

  /**
   * Plays an uploaded audio file through the Original channel (with monitoring ON)
   * so users can hear the original clip get ducked/muted by the translation.
   */
  public async playOriginalClipBuffer(arrayBuffer: ArrayBuffer): Promise<void> {
    this.stopOriginalClip();
    const ctx = this.ensureContext();
    this.setMonitorOriginal(true);

    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    if (this.preOriginalAnalyser) {
      src.connect(this.preOriginalAnalyser);
    }
    this.clipSourceNode = src;
    src.onended = () => {
      if (this.clipSourceNode === src) {
        this.clipSourceNode = null;
      }
    };
    src.start();
  }

  public stopOriginalClip(): void {
    if (this.clipSourceNode) {
      try {
        this.clipSourceNode.stop();
        this.clipSourceNode.disconnect();
      } catch {
        // Ignore already stopped
      }
      this.clipSourceNode = null;
    }
  }

  /**
   * Runs a 3.6-second interactive DSP calibration test: plays a smooth broadcast
   * program bed through the Original channel, then simulates a 2.0-second TTS
   * voice-over burst so the user visibly & audibly verifies original muting/ducking.
   */
  public runDemoDuckingTest(onFinish?: () => void): () => void {
    this.stopDemoBed();
    const ctx = this.ensureContext();
    const prevMonitor = this.monitorOriginal;
    this.setMonitorOriginal(true);

    const bedGain = ctx.createGain();
    bedGain.gain.setValueAtTime(0.001, ctx.currentTime);
    bedGain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 0.15);
    if (this.preOriginalAnalyser) {
      bedGain.connect(this.preOriginalAnalyser);
    }
    this.demoGainNode = bedGain;

    const freqs = [196, 246.94, 293.66];
    this.demoOscNodes = freqs.map((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.5 : 0.25;
      osc.connect(g);
      g.connect(bedGain);
      osc.start();
      return osc;
    });

    // At 750ms, inject a 1.9s simulated TTS speech tone into the TTS bus so ducking triggers!
    const t1 = window.setTimeout(() => {
      const ttsOsc = ctx.createOscillator();
      const ttsEnv = ctx.createGain();
      ttsOsc.type = 'sine';
      ttsOsc.frequency.setValueAtTime(340, ctx.currentTime);
      ttsOsc.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.6);
      ttsOsc.frequency.exponentialRampToValueAtTime(310, ctx.currentTime + 1.8);
      ttsEnv.gain.setValueAtTime(0.001, ctx.currentTime);
      ttsEnv.gain.linearRampToValueAtTime(0.28, ctx.currentTime + 0.08);
      ttsEnv.gain.setValueAtTime(0.24, ctx.currentTime + 1.65);
      ttsEnv.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.85);
      ttsOsc.connect(ttsEnv);
      if (this.ttsGainNode) {
        ttsEnv.connect(this.ttsGainNode);
      }
      this.markTtsActivityStart();
      ttsOsc.start();
      ttsOsc.stop(ctx.currentTime + 1.9);
      ttsOsc.onended = () => {
        this.scheduleTtsActivityRelease();
      };
    }, 750);

    const t2 = window.setTimeout(() => {
      this.stopDemoBed();
      this.setMonitorOriginal(prevMonitor);
      onFinish?.();
    }, 3600);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      this.stopDemoBed();
      this.setMonitorOriginal(prevMonitor);
    };
  }

  public stopDemoBed(): void {
    for (const osc of this.demoOscNodes) {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        // Ignore
      }
    }
    this.demoOscNodes = [];
    if (this.demoGainNode) {
      this.demoGainNode.disconnect();
      this.demoGainNode = null;
    }
  }

  public stopAllTts(): void {
    for (const src of this.activeTtsSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore
      }
    }
    this.activeTtsSources.clear();
    this.nextPcmStartTime = 0;
    this.isTtsSpeaking = false;
    this.applyDuckingRamp(false);
  }

  private startMeterLoop(): void {
    const tick = () => {
      if (
        this.preOriginalAnalyser &&
        this.postOriginalAnalyser &&
        this.ttsAnalyser &&
        this.masterAnalyser &&
        this.sourceGainNode
      ) {
        this.preOriginalAnalyser.getFloatTimeDomainData(this.preBuf);
        this.postOriginalAnalyser.getFloatTimeDomainData(this.postBuf);
        this.ttsAnalyser.getFloatTimeDomainData(this.ttsBuf);
        this.masterAnalyser.getFloatTimeDomainData(this.masterBuf);

        const nominal = dbToGain(this.config.originalGainDb);
        const currentGain = this.sourceGainNode.gain.value;
        const grDb = computeGainReductionDb(nominal, currentGain);

        const levels: AudioLevels = {
          originalPreDb: computeRmsDb(this.preBuf),
          originalPostDb: computeRmsDb(this.postBuf),
          ttsDb: computeRmsDb(this.ttsBuf),
          masterDb: computeRmsDb(this.masterBuf),
          gainReductionDb: grDb,
          isDucking: grDb < -0.5,
          isOriginalMuted: currentGain <= 0.0005,
        };

        for (const listener of this.levelListeners) {
          listener(levels);
        }
      }
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  public dispose(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.stopMicCapture();
    this.stopOriginalClip();
    this.stopDemoBed();
    this.stopAllTts();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}

export const IDLE_AUDIO_LEVELS: AudioLevels = {
  originalPreDb: SILENCE_DB,
  originalPostDb: SILENCE_DB,
  ttsDb: SILENCE_DB,
  masterDb: SILENCE_DB,
  gainReductionDb: 0,
  isDucking: false,
  isOriginalMuted: false,
};
