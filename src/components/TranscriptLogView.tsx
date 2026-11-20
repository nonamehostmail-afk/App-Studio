import { useMemo, useState } from 'react';
import { Download, Play, Search, Trash2 } from 'lucide-react';
import type { TranscriptEntry } from '../types/translator';
import { exportEntriesToSrt, formatTimecode } from '../utils/duckingMath';

interface TranscriptLogViewProps {
  entries: TranscriptEntry[];
  onReplayEntry: (entry: TranscriptEntry) => void;
  onClearEntries: () => void;
  onJumpToConsole: () => void;
}

export function TranscriptLogView({
  entries,
  onReplayEntry,
  onClearEntries,
  onJumpToConsole,
}: TranscriptLogViewProps) {
  const [query, setQuery] = useState('');
  const [voiceFilter, setVoiceFilter] = useState<string>('all');

  const voicesInLog = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.voiceName);
    return Array.from(set);
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (voiceFilter !== 'all' && e.voiceName !== voiceFilter) return false;
      if (!q) return true;
      return (
        e.originalText.toLowerCase().includes(q) ||
        e.translatedText.toLowerCase().includes(q) ||
        e.voiceName.toLowerCase().includes(q)
      );
    });
  }, [entries, query, voiceFilter]);

  const downloadFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleExportSrt = () => {
    const srt = exportEntriesToSrt(filtered);
    if (!srt) return;
    downloadFile(srt, 'dubcast_subtitles.srt', 'text/plain;charset=utf-8');
  };

  const handleExportTxt = () => {
    if (filtered.length === 0) return;
    const text = filtered
      .map(
        (e) =>
          `[${formatTimecode(e.timestamp)}] (${e.sourceLang.toUpperCase()} -> ${e.targetLang.toUpperCase()} · ${e.voiceName})\nОригинал: ${e.originalText}\nПеревод: ${e.translatedText}\n`,
      )
      .join('\n');
    downloadFile(text, 'dubcast_transcript.txt', 'text/plain;charset=utf-8');
  };

  return (
    <div className="bg-[#121620] border border-white/[0.08] rounded-lg">
      {/* Toolbar */}
      <div className="p-5 border-b border-white/[0.06] flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[#F1F5F9]">
            Журнал переведённых реплик эфира
          </h2>
          <p className="text-xs text-[#8B95A7] mt-0.5">
            Всего записей: <span className="font-mono tabular-nums">{entries.length}</span> · Показано:{' '}
            <span className="font-mono tabular-nums">{filtered.length}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <label htmlFor="log-search-input" className="sr-only">
              Поиск по журналу переводов
            </label>
            <input
              id="log-search-input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по тексту…"
              className="bg-[#0B0E14] border border-white/[0.1] rounded-md pl-8 pr-3 py-1.5 text-xs text-[#F1F5F9] placeholder:text-[#64748B] w-48 focus:outline-none focus:border-[#E11D48]"
            />
          </div>

          <label htmlFor="log-voice-filter" className="sr-only">
            Фильтр по голосу
          </label>
          <select
            id="log-voice-filter"
            value={voiceFilter}
            onChange={(e) => setVoiceFilter(e.target.value)}
            className="bg-[#0B0E14] border border-white/[0.1] rounded-md px-2.5 py-1.5 text-xs text-[#F1F5F9]"
          >
            <option value="all">Все голоса</option>
            {voicesInLog.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={handleExportSrt}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08] disabled:opacity-40 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Экспорт .SRT
          </button>

          <button
            type="button"
            onClick={handleExportTxt}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08] disabled:opacity-40 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Экспорт .TXT
          </button>

          <button
            type="button"
            onClick={onClearEntries}
            disabled={entries.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-[#FB7185] bg-[#0B0E14] hover:bg-[#1C2230] border border-white/[0.08] disabled:opacity-40 whitespace-nowrap"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Очистить
          </button>
        </div>
      </div>

      {/* Table or Empty State */}
      {filtered.length === 0 ? (
        <div className="p-12 text-center">
          <p className="text-sm font-medium text-[#E6ECF5] mb-1">
            {entries.length === 0
              ? 'Журнал эфира пуст'
              : 'По вашему запросу реплик не найдено'}
          </p>
          <p className="text-xs text-[#8B95A7] mb-4">
            {entries.length === 0
              ? 'Запустите живой перевод или озвучьте тестовую реплику в пульте, чтобы увидеть историю и скачать субтитры.'
              : 'Сбросьте строку поиска или выберите другой фильтр голоса.'}
          </p>
          {entries.length === 0 ? (
            <button
              type="button"
              onClick={onJumpToConsole}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-[#E11D48] hover:bg-[#BE123C] text-white"
            >
              Перейти в пульт перевода
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setVoiceFilter('all');
              }}
              className="px-4 py-2 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#F1F5F9]"
            >
              Сбросить фильтры
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/[0.06] text-[11px] font-medium text-[#8B95A7]">
                <th className="py-3 px-4 w-24">Время</th>
                <th className="py-3 px-4">Оригинал</th>
                <th className="py-3 px-4">Перевод (озвучено)</th>
                <th className="py-3 px-4 w-44">Модель / Голос</th>
                <th className="py-3 px-4 w-28 text-right">Задержка</th>
                <th className="py-3 px-4 w-28 text-right">Действие</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05] text-xs">
              {filtered.map((entry, idx) => (
                <tr
                  key={entry.id}
                  className="hover:bg-white/[0.02] transition-colors align-top"
                >
                  <td className="py-3.5 px-4 font-mono tabular-nums text-[#94A3B8] whitespace-nowrap">
                    {formatTimecode(entry.timestamp)}
                  </td>
                  <td className="py-3.5 px-4 text-[#94A3B8] max-w-xs leading-relaxed">
                    {entry.originalText}
                  </td>
                  <td className="py-3.5 px-4 text-[#F8FAFC] font-medium max-w-md leading-relaxed">
                    {entry.translatedText}
                  </td>
                  <td className="py-3.5 px-4 text-[#94A3B8] whitespace-nowrap">
                    <div className="text-[#E6ECF5] font-medium">
                      {entry.voiceName}
                    </div>
                    <div className="text-[11px] font-mono text-[#64748B]">
                      {entry.ttsModel}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 font-mono tabular-nums text-right text-[#CBD5E1] whitespace-nowrap">
                    {entry.translateMs + entry.ttsMs} мс
                  </td>
                  <td className="py-3.5 px-4 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onReplayEntry(entry)}
                      aria-label={`Повторить озвучку записи ${idx + 1}`}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] transition-colors"
                    >
                      <Play className="w-3 h-3" />
                      <span>Озвучить</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
