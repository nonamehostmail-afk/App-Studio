import { useEffect, useRef } from 'react';
import type { BroadcastDuckingEngine } from '../audio/duckingEngine';
import { dbToMeterPercent, formatDbLabel } from '../utils/duckingMath';

interface LevelMetersProps {
  engine: BroadcastDuckingEngine;
  modeLabel: string;
}

const SCALE_MARKS = ['-60', '-48', '-36', '-24', '-12', '-6', '0'];

export function LevelMeters({ engine, modeLabel }: LevelMetersProps) {
  const preBarRef = useRef<HTMLDivElement>(null);
  const preValRef = useRef<HTMLSpanElement>(null);

  const postBarRef = useRef<HTMLDivElement>(null);
  const postValRef = useRef<HTMLSpanElement>(null);

  const grBarRef = useRef<HTMLDivElement>(null);
  const grValRef = useRef<HTMLSpanElement>(null);

  const ttsBarRef = useRef<HTMLDivElement>(null);
  const ttsValRef = useRef<HTMLSpanElement>(null);

  const statusTextRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    return engine.subscribeLevels((levels) => {
      const prePct = dbToMeterPercent(levels.originalPreDb);
      const postPct = dbToMeterPercent(levels.originalPostDb);
      const ttsPct = dbToMeterPercent(levels.ttsDb);
      // Gain reduction goes from 0 (0%) to -60 dB (100% bar right-to-left)
      const grPct = Math.min(100, Math.max(0, (Math.abs(levels.gainReductionDb) / 60) * 100));

      if (preBarRef.current) preBarRef.current.style.width = `${prePct.toFixed(1)}%`;
      if (preValRef.current) preValRef.current.textContent = formatDbLabel(levels.originalPreDb);

      if (postBarRef.current) postBarRef.current.style.width = `${postPct.toFixed(1)}%`;
      if (postValRef.current) {
        postValRef.current.textContent = levels.isOriginalMuted
          ? '-∞ дБ (заглушён)'
          : formatDbLabel(levels.originalPostDb);
      }

      if (grBarRef.current) grBarRef.current.style.width = `${grPct.toFixed(1)}%`;
      if (grValRef.current) {
        grValRef.current.textContent =
          levels.gainReductionDb <= -59.5
            ? '-∞ дБ'
            : `${levels.gainReductionDb.toFixed(1)} дБ`;
      }

      if (ttsBarRef.current) ttsBarRef.current.style.width = `${ttsPct.toFixed(1)}%`;
      if (ttsValRef.current) ttsValRef.current.textContent = formatDbLabel(levels.ttsDb);

      if (statusTextRef.current) {
        if (levels.isOriginalMuted) {
          statusTextRef.current.textContent = 'Оригинал заглушён — активна замена переводом';
          statusTextRef.current.className = 'text-xs font-medium text-[#FB7185]';
        } else if (levels.isDucking) {
          statusTextRef.current.textContent = 'Активен авто-дакинг исходного звука';
          statusTextRef.current.className = 'text-xs font-medium text-[#FBBF24]';
        } else {
          statusTextRef.current.textContent = 'Ожидание речи перевода';
          statusTextRef.current.className = 'text-xs text-[#8B95A7]';
        }
      }
    });
  }, [engine]);

  return (
    <div
      className="bg-[#121620] border border-white/[0.08] rounded-lg p-5"
      data-testid="broadcast-level-meters"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-[#F1F5F9]">
            Монитор маршрутизации и заглушения (dBFS)
          </h2>
          <p className="text-xs text-[#8B95A7] mt-0.5">
            Режим: {modeLabel}
          </p>
        </div>
        <span ref={statusTextRef} className="text-xs text-[#8B95A7]">
          Ожидание речи перевода
        </span>
      </div>

      <div className="space-y-3.5">
        {/* Channel 1: Original Input Pre-Duck */}
        <div>
          <div className="flex items-center justify-between gap-2 text-xs mb-1">
            <span className="text-[#CBD5E1] font-medium min-w-0 truncate">
              1. Исходный сигнал (вход)
            </span>
            <span
              ref={preValRef}
              className="font-mono tabular-nums text-[#94A3B8] whitespace-nowrap shrink-0"
            >
              -∞ дБ
            </span>
          </div>
          <div className="h-2.5 w-full bg-[#1C2230] rounded overflow-hidden">
            <div
              ref={preBarRef}
              className="h-full bg-[#64748B] transition-[width] duration-75 ease-out"
              style={{ width: '0%' }}
            />
          </div>
        </div>

        {/* Channel 2: Gain Reduction (Ducking / Mute) */}
        <div>
          <div className="flex items-center justify-between gap-2 text-xs mb-1">
            <span className="text-[#CBD5E1] font-medium min-w-0 truncate">
              2. Подавление оригинала (Gain Reduction)
            </span>
            <span
              ref={grValRef}
              className="font-mono tabular-nums text-[#FBBF24] whitespace-nowrap shrink-0"
            >
              0.0 дБ
            </span>
          </div>
          <div className="h-2.5 w-full bg-[#1C2230] rounded overflow-hidden flex justify-end">
            <div
              ref={grBarRef}
              className="h-full bg-[#F59E0B] transition-[width] duration-75 ease-out"
              style={{ width: '0%' }}
            />
          </div>
        </div>

        {/* Channel 3: Original Post-Duck Output */}
        <div>
          <div className="flex items-center justify-between gap-2 text-xs mb-1">
            <span className="text-[#CBD5E1] font-medium min-w-0 truncate">
              3. Исходный сигнал после заглушения
            </span>
            <span
              ref={postValRef}
              className="font-mono tabular-nums text-[#94A3B8] whitespace-nowrap shrink-0"
            >
              -∞ дБ
            </span>
          </div>
          <div className="h-2.5 w-full bg-[#1C2230] rounded overflow-hidden">
            <div
              ref={postBarRef}
              className="h-full bg-[#38BDF8] transition-[width] duration-75 ease-out"
              style={{ width: '0%' }}
            />
          </div>
        </div>

        {/* Channel 4: Gemini 3.8 Flash TTS Replaced Audio */}
        <div>
          <div className="flex items-center justify-between gap-2 text-xs mb-1">
            <span className="text-[#F8FAFC] font-medium min-w-0 truncate">
              4. Озвучка перевода (Gemini 3.8 Flash TTS → OBS)
            </span>
            <span
              ref={ttsValRef}
              className="font-mono tabular-nums text-[#34D399] whitespace-nowrap shrink-0"
            >
              -∞ дБ
            </span>
          </div>
          <div className="h-3 w-full bg-[#1C2230] rounded overflow-hidden">
            <div
              ref={ttsBarRef}
              className="h-full bg-gradient-to-r from-[#10B981] via-[#22C55E] to-[#F59E0B] transition-[width] duration-75 ease-out"
              style={{ width: '0%' }}
            />
          </div>
        </div>

        {/* Calibrated dBFS Scale */}
        <div
          className="flex items-center justify-between pt-1 text-[11px] font-mono tabular-nums text-[#64748B]"
          aria-hidden="true"
        >
          {SCALE_MARKS.map((mark) => (
            <span key={mark}>{mark}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
