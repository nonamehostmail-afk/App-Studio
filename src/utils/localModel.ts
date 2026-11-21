import type { LocalModelProtocol } from '../types/translator';

/**
 * Normalizes a local LLM base URL (Ollama, LM Studio, vLLM, llama.cpp).
 */
export function normalizeLocalBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

/**
 * Builds the chat endpoint URL for a local translation model.
 */
export function buildLocalChatEndpoint(
  baseUrl: string,
  protocol: LocalModelProtocol,
): string {
  const clean = normalizeLocalBaseUrl(baseUrl);
  if (!clean) {
    throw new Error('Укажите URL локального сервера модели (например, http://localhost:11434).');
  }
  if (protocol === 'ollama') {
    if (clean.endsWith('/api/chat')) return clean;
    return `${clean}/api/chat`;
  }
  // OpenAI-compatible (LM Studio, vLLM, llama.cpp, Ollama /v1)
  if (clean.endsWith('/chat/completions')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

/**
 * Builds the model listing endpoint URL for a local LLM server.
 */
export function buildLocalModelsEndpoint(
  baseUrl: string,
  protocol: LocalModelProtocol,
): string {
  const clean = normalizeLocalBaseUrl(baseUrl);
  if (!clean) {
    throw new Error('Укажите URL локального сервера модели.');
  }
  if (protocol === 'ollama') {
    if (clean.endsWith('/api/tags')) return clean;
    return `${clean}/api/tags`;
  }
  if (clean.endsWith('/models')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/models`;
  return `${clean}/v1/models`;
}

/**
 * Builds the translation system prompt and request body for Ollama or OpenAI-compatible local models.
 */
export function buildLocalTranslateRequest(params: {
  protocol: LocalModelProtocol;
  modelName: string;
  text: string;
  sourceLangName: string;
  targetLangName: string;
}): Record<string, unknown> {
  const systemPrompt = [
    'You are a simultaneous live broadcast interpreter for OBS Studio.',
    `Translate the user utterance from ${params.sourceLangName} into natural spoken ${params.targetLangName} suitable for immediate voice-over dubbing.`,
    'Preserve tone and brevity. Output ONLY the translated text without quotes, markdown, notes, or explanations.',
  ].join(' ');

  if (params.protocol === 'ollama') {
    return {
      model: params.modelName.trim(),
      stream: false,
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: params.text.trim() },
      ],
    };
  }

  return {
    model: params.modelName.trim(),
    temperature: 0.2,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: params.text.trim() },
    ],
  };
}

/**
 * Extracts clean translated text from either Ollama or OpenAI-compatible JSON responses.
 */
export function extractLocalTranslationText(
  protocol: LocalModelProtocol,
  json: unknown,
): string {
  if (!json || typeof json !== 'object') return '';
  const data = json as Record<string, unknown>;

  if (protocol === 'ollama') {
    const msg = data.message as { content?: unknown } | undefined;
    if (typeof msg?.content === 'string') {
      return stripThinkTags(msg.content);
    }
    if (typeof data.response === 'string') {
      return stripThinkTags(data.response);
    }
  }

  const choices = data.choices as
    | Array<{ message?: { content?: unknown }; text?: unknown }>
    | undefined;
  const first = choices?.[0];
  if (typeof first?.message?.content === 'string') {
    return stripThinkTags(first.message.content);
  }
  if (typeof first?.text === 'string') {
    return stripThinkTags(first.text);
  }
  return '';
}

/**
 * Strips `<think>...</think>` blocks emitted by reasoning local models (e.g. DeepSeek-R1 / QwQ).
 */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Parses model names from Ollama `/api/tags` or OpenAI `/v1/models`.
 */
export function parseLocalModelList(
  protocol: LocalModelProtocol,
  json: unknown,
): string[] {
  if (!json || typeof json !== 'object') return [];
  const data = json as Record<string, unknown>;

  if (protocol === 'ollama' && Array.isArray(data.models)) {
    return data.models
      .map((m) => (m as { name?: string })?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  }

  if (Array.isArray(data.data)) {
    return data.data
      .map((m) => (m as { id?: string })?.id)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  }

  return [];
}

/**
 * Normalizes an OBS WebSocket connection URL (supports bare host + port, ws://, or wss://).
 */
export function buildObsWsUrl(
  host: string,
  port: number,
  useTls: boolean,
): string {
  const trimmed = host.trim();
  if (!trimmed) {
    throw new Error('Укажите хост OBS WebSocket.');
  }
  if (/^wss?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const scheme = useTls ? 'wss' : 'ws';
  const cleanHost = trimmed.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (cleanHost.includes(':')) {
    return `${scheme}://${cleanHost}`;
  }
  return `${scheme}://${cleanHost}:${port}`;
}

/**
 * Produces an actionable Russian diagnostic message for OBS WebSocket connection failures.
 */
export function diagnoseObsWsFailure(params: {
  closeCode?: number;
  host: string;
  port: number;
  useTls: boolean;
  isHttpsPage: boolean;
  isInIframe: boolean;
  isSecurityError?: boolean;
}): string {
  if (params.closeCode === 4009) {
    return 'OBS отклонил подключение: неверный пароль сервера WebSocket (код 4009). Проверьте пароль в OBS → Инструменты → Настройки сервера WebSocket.';
  }
  if (params.closeCode === 4006 || params.closeCode === 4007) {
    return 'Несовместимая версия OBS WebSocket. Обновите OBS Studio до версии 28 или выше (требуется встроенный WebSocket v5).';
  }
  if (params.isSecurityError || (params.isHttpsPage && !params.useTls && params.isInIframe)) {
    return `Браузер заблокировал прямое ws:// подключение к ${params.host}:${params.port} с HTTPS-страницы внутри iframe. Выберите режим «Через Browser Source внутри OBS» ниже — тогда плагин подключится к OBS напрямую на вашем ПК без ограничений браузера.`;
  }
  if (params.isHttpsPage && !params.useTls && params.host.trim() === '127.0.0.1') {
    return `На HTTPS-странице браузер часто блокирует ws://127.0.0.1:${params.port}. Попробуйте хост «localhost» или выберите режим «Через Browser Source внутри OBS».`;
  }
  return `Не удалось подключиться к OBS WebSocket (${params.host}:${params.port}). Убедитесь, что OBS запущен, включён сервер WebSocket (Инструменты → Настройки сервера WebSocket, порт ${params.port}), или используйте режим «Через Browser Source внутри OBS».`;
}
