import { useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Link2,
  Plug,
  PlugZap,
  VolumeX,
} from 'lucide-react';
import type {
  DuckingConfig,
  ObsOverlayConfig,
  ObsWebSocketConfig,
} from '../types/translator';
import type { ObsConnectionState } from '../utils/obsWebSocket';
import { buildObsOverlayUrl, generateObsLuaScript } from '../utils/duckingMath';

interface ObsPluginViewProps {
  overlayConfig: ObsOverlayConfig;
  onChangeOverlayConfig: (next: ObsOverlayConfig) => void;
  wsConfig: ObsWebSocketConfig;
  onChangeWsConfig: (next: ObsWebSocketConfig) => void;
  wsState: ObsConnectionState;
  wsMessage: string;
  obsSources: string[];
  onConnectObsWs: () => Promise<void>;
  onDisconnectObsWs: () => void;
  onTestObsMute: () => Promise<void>;
  duckingConfig: DuckingConfig;
  latestOriginal: string;
  latestTranslated: string;
  obsClientsCount: number;
}

export function ObsPluginView({
  overlayConfig,
  onChangeOverlayConfig,
  wsConfig,
  onChangeWsConfig,
  wsState,
  wsMessage,
  obsSources,
  onConnectObsWs,
  onDisconnectObsWs,
  onTestObsMute,
  duckingConfig,
  latestOriginal,
  latestTranslated,
  obsClientsCount,
}: ObsPluginViewProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedLua, setCopiedLua] = useState(false);
  const [wsValidationError, setWsValidationError] = useState('');

  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const overlayUrl = buildObsOverlayUrl(origin, overlayConfig);

  const luaScript = generateObsLuaScript({
    sourceName: wsConfig.targetSourceName || 'Захват выходного звука',
    duckDb: duckingConfig.duckLevelDb,
    muteCompletely: duckingConfig.mode !== 'auto_duck',
    overlayUrl,
  });

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(overlayUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Fallback ignored
    }
  };

  const handleCopyLua = async () => {
    try {
      await navigator.clipboard.writeText(luaScript);
      setCopiedLua(true);
      window.setTimeout(() => setCopiedLua(false), 2000);
    } catch {
      // Fallback ignored
    }
  };

  const handleDownloadLua = () => {
    const blob = new Blob([luaScript], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dubcast_obs_translator.lua';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleConnectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wsConfig.host.trim()) {
      setWsValidationError('Укажите IP-адрес или хост OBS WebSocket.');
      return;
    }
    if (!Number.isFinite(wsConfig.port) || wsConfig.port < 1 || wsConfig.port > 65535) {
      setWsValidationError('Укажите корректный порт (по умолчанию 4455).');
      return;
    }
    setWsValidationError('');
    await onConnectObsWs();
  };

  const previewBgClass =
    overlayConfig.previewBackdrop === 'chroma'
      ? 'bg-[#00B140]'
      : overlayConfig.previewBackdrop === 'transparent'
        ? 'bg-[radial-gradient(#263042_1px,transparent_1px)] [background-size:12px_12px] bg-[#0F131D]'
        : 'bg-[#090C12]';

  const previewTextSize =
    overlayConfig.fontSize === 'lg'
      ? 'text-lg'
      : overlayConfig.fontSize === 'sm'
        ? 'text-xs'
        : 'text-sm';

  return (
    <div className="space-y-6">
      {/* Section 1: OBS Browser Source (Audio + Captions) */}
      <section className="bg-[#121620] border border-white/[0.08] rounded-lg p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <div>
            <h2 className="text-base font-semibold text-[#F1F5F9]">
              1. Источник браузера OBS (Browser Source)
            </h2>
            <p className="text-xs text-[#8B95A7] mt-0.5">
              Добавьте URL в OBS → Источники → Браузер и включите «Управление аудио через OBS» для вывода озвучки отдельной дорожкой
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-[#94A3B8]">
            Подключено оверлеев: {obsClientsCount}
          </span>
        </div>

        {/* Copyable URL Field */}
        <div className="flex flex-col sm:flex-row gap-2 mb-5">
          <div className="relative flex-1">
            <label htmlFor="obs-browser-url" className="sr-only">
              URL Источника браузера OBS
            </label>
            <input
              id="obs-browser-url"
              type="text"
              readOnly
              value={overlayUrl}
              className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3.5 py-2.5 text-xs font-mono text-[#E6ECF5] focus:outline-none focus:border-[#E11D48]"
            />
          </div>
          <button
            type="button"
            onClick={handleCopyUrl}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-md text-xs font-medium bg-[#E11D48] hover:bg-[#BE123C] text-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            {copiedUrl ? (
              <>
                <Check className="w-3.5 h-3.5" />
                Скопировано
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Копировать URL
              </>
            )}
          </button>
          <a
            href={overlayUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08] transition-colors whitespace-nowrap shrink-0"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Открыть оверлей
          </a>
        </div>

        {/* Overlay Settings + Live Preview */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
          <div className="lg:col-span-5 space-y-3.5">
            <div className="flex items-center justify-between py-1">
              <label
                htmlFor="obs-audio-toggle"
                className="text-xs text-[#E6ECF5] font-medium"
              >
                Выводить звук перевода в Browser Source
              </label>
              <input
                id="obs-audio-toggle"
                type="checkbox"
                checked={overlayConfig.outputAudioInOverlay}
                onChange={(e) =>
                  onChangeOverlayConfig({
                    ...overlayConfig,
                    outputAudioInOverlay: e.target.checked,
                  })
                }
                className="w-4 h-4 accent-[#E11D48] cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between py-1">
              <label
                htmlFor="obs-subs-toggle"
                className="text-xs text-[#E6ECF5] font-medium"
              >
                Показывать субтитры перевода в кадре
              </label>
              <input
                id="obs-subs-toggle"
                type="checkbox"
                checked={overlayConfig.showSubtitles}
                onChange={(e) =>
                  onChangeOverlayConfig({
                    ...overlayConfig,
                    showSubtitles: e.target.checked,
                  })
                }
                className="w-4 h-4 accent-[#E11D48] cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between py-1">
              <label
                htmlFor="obs-orig-toggle"
                className="text-xs text-[#E6ECF5] font-medium"
              >
                Дублировать строку оригинала
              </label>
              <input
                id="obs-orig-toggle"
                type="checkbox"
                checked={overlayConfig.showOriginal}
                onChange={(e) =>
                  onChangeOverlayConfig({
                    ...overlayConfig,
                    showOriginal: e.target.checked,
                  })
                }
                className="w-4 h-4 accent-[#E11D48] cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between py-1">
              <label
                htmlFor="obs-cam-pip-toggle"
                className="text-xs text-[#E6ECF5] font-medium"
              >
                Показывать мини-окно камеры (PiP)
              </label>
              <input
                id="obs-cam-pip-toggle"
                type="checkbox"
                checked={overlayConfig.showCameraPip}
                onChange={(e) =>
                  onChangeOverlayConfig({
                    ...overlayConfig,
                    showCameraPip: e.target.checked,
                  })
                }
                className="w-4 h-4 accent-[#E11D48] cursor-pointer"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <div>
                <label
                  htmlFor="obs-pos-select"
                  className="block text-xs text-[#8B95A7] mb-1"
                >
                  Позиция титров
                </label>
                <select
                  id="obs-pos-select"
                  value={overlayConfig.position}
                  onChange={(e) =>
                    onChangeOverlayConfig({
                      ...overlayConfig,
                      position: e.target.value as 'bottom' | 'top',
                    })
                  }
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-2.5 py-2 text-xs text-[#F1F5F9]"
                >
                  <option value="bottom">Внизу (Lower-third)</option>
                  <option value="top">Вверху экрана</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="obs-size-select"
                  className="block text-xs text-[#8B95A7] mb-1"
                >
                  Размер шрифта
                </label>
                <select
                  id="obs-size-select"
                  value={overlayConfig.fontSize}
                  onChange={(e) =>
                    onChangeOverlayConfig({
                      ...overlayConfig,
                      fontSize: e.target.value as 'sm' | 'md' | 'lg',
                    })
                  }
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-2.5 py-2 text-xs text-[#F1F5F9]"
                >
                  <option value="sm">Компактный</option>
                  <option value="md">Стандартный</option>
                  <option value="lg">Крупный эфирный</option>
                </select>
              </div>
            </div>

            <div className="pt-1">
              <span className="block text-xs text-[#8B95A7] mb-1.5">
                Фон предпросмотра (в OBS фон всегда прозрачный)
              </span>
              <div className="grid grid-cols-3 gap-1 p-1 bg-[#0B0E14] rounded-md border border-white/[0.06]">
                {(
                  [
                    ['dark', 'Тёмный'],
                    ['transparent', 'Сетка'],
                    ['chroma', 'Хромакей'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() =>
                      onChangeOverlayConfig({
                        ...overlayConfig,
                        previewBackdrop: id,
                      })
                    }
                    className={`py-1.5 rounded text-xs font-medium transition-colors ${
                      overlayConfig.previewBackdrop === id
                        ? 'bg-[#252D40] text-white'
                        : 'text-[#8B95A7] hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Live Overlay Stage Preview */}
          <div
            className={`lg:col-span-7 rounded-md border border-white/[0.1] relative min-h-[210px] p-4 flex flex-col ${
              overlayConfig.position === 'top' ? 'justify-start' : 'justify-end'
            } ${previewBgClass}`}
          >
            <span className="absolute top-2.5 left-3 text-[11px] font-mono text-white/50">
              1920 × 1080 · Предпросмотр OBS
            </span>
            {overlayConfig.showCameraPip && (
              <div className="absolute top-3 right-3 w-32 aspect-video rounded border border-white/20 bg-[#151D2F] flex items-center justify-center text-[10px] font-mono text-[#94A3B8]">
                CAM PiP
              </div>
            )}
            {overlayConfig.showSubtitles ? (
              <div className="bg-[#0B0E14]/90 backdrop-blur-sm border border-white/[0.12] rounded-md px-4 py-3 max-w-xl">
                {overlayConfig.showOriginal && (
                  <p className="text-xs text-[#94A3B8] mb-1">
                    {latestOriginal ||
                      'Welcome back to the main stage, everyone.'}
                  </p>
                )}
                <p className={`${previewTextSize} font-semibold text-white leading-snug`}>
                  {latestTranslated ||
                    'С возвращением на главную сцену, друзья. Оригинальный звук заглушён.'}
                </p>
              </div>
            ) : (
              <div className="text-center text-xs text-white/60 my-auto">
                Субтитры отключены — Browser Source передаёт только аудиодорожку перевода.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Section 2 & 3: OBS WebSocket v5 Auto-Ducker + Downloadable Lua Plugin */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* OBS WebSocket v5 Live Control */}
        <section className="xl:col-span-6 bg-[#121620] border border-white/[0.08] rounded-lg p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-semibold text-[#F1F5F9]">
                2. Авто-заглушение в OBS (WebSocket v5)
              </h2>
              <p className="text-xs text-[#8B95A7] mt-0.5">
                Напрямую выключает исходный аудиоисточник в микшере OBS Studio на время озвучки Gemini 3.8 Flash TTS
              </p>
            </div>
            <span
              className={`text-xs font-medium whitespace-nowrap ${
                wsState === 'connected'
                  ? 'text-[#34D399]'
                  : wsState === 'error'
                    ? 'text-[#FB7185]'
                    : 'text-[#8B95A7]'
              }`}
            >
              {wsState === 'connected'
                ? 'Подключено'
                : wsState === 'connecting'
                  ? 'Подключение…'
                  : wsState === 'error'
                    ? 'Нет связи'
                    : 'Отключено'}
            </span>
          </div>

          <form onSubmit={handleConnectSubmit} className="space-y-3.5" noValidate>
            {/* Transport Mode Switcher: Solves HTTPS/iframe mixed-content blocking of ws://127.0.0.1:4455 */}
            <div>
              <span className="block text-xs text-[#8B95A7] mb-1.5">
                Способ подключения к OBS Studio
              </span>
              <div
                role="group"
                aria-label="Способ подключения к OBS WebSocket"
                className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 p-1 bg-[#0B0E14] rounded-md border border-white/[0.06]"
              >
                <button
                  type="button"
                  aria-pressed={wsConfig.transport === 'browser_source_bridge'}
                  onClick={() =>
                    onChangeWsConfig({
                      ...wsConfig,
                      transport: 'browser_source_bridge',
                    })
                  }
                  className={`px-3 py-2 rounded text-xs font-medium text-left transition-colors ${
                    wsConfig.transport === 'browser_source_bridge'
                      ? 'bg-[#E11D48] text-white'
                      : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
                  }`}
                >
                  Через Browser Source (для HTTPS)
                </button>
                <button
                  type="button"
                  aria-pressed={wsConfig.transport === 'direct'}
                  onClick={() =>
                    onChangeWsConfig({
                      ...wsConfig,
                      transport: 'direct',
                    })
                  }
                  className={`px-3 py-2 rounded text-xs font-medium text-left transition-colors ${
                    wsConfig.transport === 'direct'
                      ? 'bg-[#E11D48] text-white'
                      : 'text-[#94A3B8] hover:text-white hover:bg-white/[0.04]'
                  }`}
                >
                  Прямое (ws:// / wss://)
                </button>
              </div>
              <p className="text-[11px] text-[#8B95A7] mt-1.5 leading-relaxed">
                {wsConfig.transport === 'browser_source_bridge'
                  ? 'Рекомендуется: обходит блокировку ws://localhost в HTTPS-браузере. Добавьте URL из блока 1 в OBS как «Источник браузера», затем нажмите «Подключить» — оверлей сам свяжется с OBS на вашем ПК.'
                  : 'Прямое подключение из текущей вкладки браузера. Если браузер блокирует ws://127.0.0.1 на HTTPS-странице, укажите хост localhost или переключитесь на режим «Через Browser Source».'}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label
                  htmlFor="obs-ws-host"
                  className="block text-xs text-[#8B95A7] mb-1"
                >
                  Хост OBS WebSocket
                </label>
                <input
                  id="obs-ws-host"
                  type="text"
                  value={wsConfig.host}
                  onChange={(e) =>
                    onChangeWsConfig({ ...wsConfig, host: e.target.value })
                  }
                  placeholder="localhost"
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs font-mono text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
                />
              </div>
              <div>
                <label
                  htmlFor="obs-ws-port"
                  className="block text-xs text-[#8B95A7] mb-1"
                >
                  Порт
                </label>
                <input
                  id="obs-ws-port"
                  type="number"
                  value={wsConfig.port}
                  onChange={(e) =>
                    onChangeWsConfig({
                      ...wsConfig,
                      port: Number(e.target.value),
                    })
                  }
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs font-mono tabular-nums text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="obs-ws-password"
                  className="block text-xs text-[#8B95A7] mb-1"
                >
                  Пароль сервера (если включён)
                </label>
                <input
                  id="obs-ws-password"
                  type="password"
                  value={wsConfig.password}
                  onChange={(e) =>
                    onChangeWsConfig({ ...wsConfig, password: e.target.value })
                  }
                  placeholder="Оставьте пустым без пароля"
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
                />
              </div>
              <div>
                <label
                  htmlFor="obs-source-name"
                  className="block text-xs text-[#8B95A7] mb-1"
                >
                  Имя аудиоисточника в OBS
                </label>
                {obsSources.length > 0 ? (
                  <select
                    id="obs-source-name"
                    value={wsConfig.targetSourceName}
                    onChange={(e) =>
                      onChangeWsConfig({
                        ...wsConfig,
                        targetSourceName: e.target.value,
                      })
                    }
                    className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs text-[#F1F5F9]"
                  >
                    {obsSources.map((src) => (
                      <option key={src} value={src}>
                        {src}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="obs-source-name"
                    type="text"
                    value={wsConfig.targetSourceName}
                    onChange={(e) =>
                      onChangeWsConfig({
                        ...wsConfig,
                        targetSourceName: e.target.value,
                      })
                    }
                    placeholder="Захват выходного звука"
                    className="w-full bg-[#0B0E14] border border-white/[0.1] rounded-md px-3 py-2 text-xs text-[#F1F5F9] focus:outline-none focus:border-[#E11D48]"
                  />
                )}
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="obs-auto-mute-toggle"
                  className="text-xs text-[#CBD5E1]"
                >
                  Автоматически глушить выбранный источник при озвучке
                </label>
                <input
                  id="obs-auto-mute-toggle"
                  type="checkbox"
                  checked={wsConfig.autoControlSource}
                  onChange={(e) =>
                    onChangeWsConfig({
                      ...wsConfig,
                      autoControlSource: e.target.checked,
                    })
                  }
                  className="w-4 h-4 accent-[#E11D48] cursor-pointer"
                />
              </div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="obs-tls-toggle"
                  className="text-xs text-[#CBD5E1]"
                >
                  Использовать защищённый туннель (wss:// / Cloudflare Tunnel)
                </label>
                <input
                  id="obs-tls-toggle"
                  type="checkbox"
                  checked={wsConfig.useTls}
                  onChange={(e) =>
                    onChangeWsConfig({
                      ...wsConfig,
                      useTls: e.target.checked,
                    })
                  }
                  className="w-4 h-4 accent-[#E11D48] cursor-pointer"
                />
              </div>
            </div>

            {(wsValidationError || wsMessage) && (
              <p
                role={wsValidationError || wsState === 'error' ? 'alert' : 'status'}
                className={`text-xs leading-relaxed ${
                  wsValidationError || wsState === 'error'
                    ? 'text-[#FB7185]'
                    : 'text-[#34D399]'
                }`}
              >
                {wsValidationError || wsMessage}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2.5 pt-2">
              {wsState === 'connected' ? (
                <>
                  <button
                    type="button"
                    onClick={onDisconnectObsWs}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08]"
                  >
                    <Plug className="w-3.5 h-3.5" />
                    Отключиться
                  </button>
                  <button
                    type="button"
                    onClick={onTestObsMute}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-medium bg-[#E11D48] hover:bg-[#BE123C] text-white"
                  >
                    <VolumeX className="w-3.5 h-3.5" />
                    Тест мута в OBS (2 сек)
                  </button>
                </>
              ) : (
                <button
                  type="submit"
                  disabled={wsState === 'connecting'}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#F1F5F9] border border-white/[0.1] disabled:opacity-50"
                >
                  <PlugZap className="w-3.5 h-3.5" />
                  {wsState === 'connecting'
                    ? 'Подключение…'
                    : wsConfig.transport === 'browser_source_bridge'
                      ? 'Подключить через Browser Source'
                      : 'Подключить OBS WebSocket'}
                </button>
              )}
            </div>
          </form>
        </section>

        {/* Downloadable OBS Lua Plugin Script */}
        <section className="xl:col-span-6 bg-[#121620] border border-white/[0.08] rounded-lg p-5 flex flex-col">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
            <div>
              <h2 className="text-base font-semibold text-[#F1F5F9]">
                3. Lua-скрипт плагина для OBS Studio
              </h2>
              <p className="text-xs text-[#8B95A7] mt-0.5">
                Готовый скрипт с вашими настройками для установки в OBS → Инструменты → Скрипты
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyLua}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[#1C2230] hover:bg-[#252D40] text-[#E6ECF5] border border-white/[0.08] whitespace-nowrap"
              >
                {copiedLua ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#34D399]" />
                    Скопировано
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Копировать код
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleDownloadLua}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium bg-[#E11D48] hover:bg-[#BE123C] text-white whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                Скачать .lua
              </button>
            </div>
          </div>

          <pre className="flex-1 bg-[#0B0E14] border border-white/[0.08] rounded-md p-3.5 text-[11px] leading-relaxed font-mono text-[#CBD5E1] overflow-x-auto max-h-[240px] overflow-y-auto">
            <code>{luaScript}</code>
          </pre>

          <ol className="mt-4 pt-3.5 border-t border-white/[0.06] space-y-1.5 text-xs text-[#94A3B8]">
            <li className="flex items-start gap-2">
              <Link2 className="w-3.5 h-3.5 text-[#E11D48] shrink-0 mt-0.5" />
              <span>
                Добавьте Источник браузера с URL выше и включите «Управление аудио через OBS», чтобы озвучка Gemini 3.8 Flash TTS появилась в микшере.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Link2 className="w-3.5 h-3.5 text-[#E11D48] shrink-0 mt-0.5" />
              <span>
                Установите скачанный <code className="text-[#E6ECF5]">dubcast_obs_translator.lua</code> (Инструменты → Скрипты → «+») или подключите OBS WebSocket v5 для автоматического заглушения исходной дорожки.
              </span>
            </li>
          </ol>
        </section>
      </div>
    </div>
  );
}
