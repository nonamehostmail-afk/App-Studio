import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  type LiveServerMessage,
} from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

const ALLOWED_VOICES = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr']);
const ALLOWED_TTS_MODELS = new Set([
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
]);

const LANGUAGE_NAMES: Record<string, string> = {
  auto: 'Auto-detected language',
  ru: 'Russian',
  en: 'English',
  es: 'Spanish',
  de: 'German',
  fr: 'French',
  ja: 'Japanese',
  zh: 'Chinese (Mandarin)',
  ko: 'Korean',
  uk: 'Ukrainian',
  pt: 'Portuguese',
  it: 'Italian',
  tr: 'Turkish',
};

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY не настроен. Укажите ключ в панели Settings > Secrets.',
    );
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('503') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('high demand') ||
        msg.includes('ECONNRESET');
      if (!isTransient || attempt === maxRetries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function formatApiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('API_KEY_INVALID') || raw.includes('PERMISSION_DENIED') || raw.includes('403')) {
    return {
      status: 403,
      message:
        'Ошибка авторизации Gemini API. Проверьте ключ в панели Settings > Secrets.',
    };
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429')) {
    return {
      status: 429,
      message:
        'Превышена квота Gemini API (429). Повторите попытку через пару секунд или выберите платный ключ в Settings > Secrets.',
    };
  }
  if (raw.includes('503') || raw.includes('UNAVAILABLE')) {
    return {
      status: 503,
      message:
        'Модель Gemini временно перегружена (503). Повторите запрос через пару секунд.',
    };
  }
  if (raw.includes('GEMINI_API_KEY')) {
    return { status: 503, message: raw };
  }
  return { status: 500, message: raw || 'Внутренняя ошибка сервера Gemini API' };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  const server = http.createServer(app);

  // Connected OBS Browser Source clients for live subtitle & audio sync
  const obsClients = new Set<WebSocket>();
  const obsWss = new WebSocketServer({ noServer: true });
  const transcribeWss = new WebSocketServer({ noServer: true });
  const liveTranslateWss = new WebSocketServer({ noServer: true });

  function broadcastToObs(payload: unknown) {
    const serialized = JSON.stringify(payload);
    for (const client of obsClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  obsWss.on('connection', (ws) => {
    obsClients.add(ws);
    ws.send(
      JSON.stringify({
        type: 'connected',
        clients: obsClients.size,
      }),
    );

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Relay console messages to all other OBS overlay listeners
        const out = JSON.stringify(msg);
        for (const client of obsClients) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(out);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      obsClients.delete(ws);
    });
  });

  // Real-time Gemini Live Transcription bridge (gemini-3.5-transcribe-live)
  transcribeWss.on('connection', async (clientWs, req) => {
    const reqUrl = new URL(req.url || '/ws/transcribe', 'http://localhost');
    const sourceLang = reqUrl.searchParams.get('lang') || 'auto';

    let session: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let closed = false;

    try {
      const ai = getAiClient();
      const languageCodes =
        sourceLang && sourceLang !== 'auto' && LANGUAGE_NAMES[sourceLang]
          ? [sourceLang]
          : [];

      session = await ai.live.connect({
        model: 'gemini-3.5-transcribe-live',
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {
            languageCodes,
          },
        },
        callbacks: {
          onopen: () => {
            if (!closed && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: 'ready' }));
            }
          },
          onmessage: (message: LiveServerMessage) => {
            if (closed || clientWs.readyState !== WebSocket.OPEN) return;
            const content = message.serverContent;
            if (content?.interimInputTranscription?.text) {
              clientWs.send(
                JSON.stringify({
                  type: 'interim',
                  text: content.interimInputTranscription.text,
                }),
              );
            }
            if (content?.inputTranscription?.text) {
              clientWs.send(
                JSON.stringify({
                  type: 'final',
                  text: content.inputTranscription.text,
                }),
              );
            }
          },
          onerror: (err) => {
            if (!closed && clientWs.readyState === WebSocket.OPEN) {
              const formatted = formatApiError(err);
              clientWs.send(
                JSON.stringify({ type: 'error', message: formatted.message }),
              );
            }
          },
          onclose: () => {
            if (!closed && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: 'closed' }));
            }
          },
        },
      });
    } catch (err) {
      const formatted = formatApiError(err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({ type: 'error', message: formatted.message }),
        );
        clientWs.close();
      }
      return;
    }

    clientWs.on('message', (data) => {
      if (!session || closed) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'audio' && typeof msg.data === 'string') {
          session.sendRealtimeInput({
            audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
          });
        }
      } catch {
        // Ignore invalid frame
      }
    });

    clientWs.on('close', () => {
      closed = true;
      try {
        session?.close();
      } catch {
        // Ignore close errors
      }
    });
  });

  // Real-time Server-to-Server Live Speech-to-Speech Translation
  // Supports both gemini-3.5-live-translate-preview and gemini-3.8-live Realtime
  liveTranslateWss.on('connection', async (clientWs, req) => {
    const reqUrl = new URL(req.url || '/ws/live-translate', 'http://localhost');
    const targetLang = reqUrl.searchParams.get('target') || 'ru';
    const engineMode = reqUrl.searchParams.get('engine') || 'translate';
    const voiceParam = reqUrl.searchParams.get('voice') || 'Kore';
    const safeTarget = LANGUAGE_NAMES[targetLang] ? targetLang : 'ru';
    const safeVoice = ALLOWED_VOICES.has(voiceParam) ? voiceParam : 'Kore';

    let session: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let closed = false;

    try {
      const ai = getAiClient();
      const useRealtimeLive = engineMode === 'realtime';

      session = await ai.live.connect({
        model: useRealtimeLive
          ? 'gemini-3.8-live'
          : 'gemini-3.5-live-translate-preview',
        config: useRealtimeLive
          ? {
              responseModalities: [Modality.AUDIO],
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: safeVoice },
                },
              },
              systemInstruction: `You are a simultaneous live broadcast voice translator for OBS Studio. Immediately translate everything you hear into natural spoken ${LANGUAGE_NAMES[safeTarget]}. Speak only the translation, with crisp broadcast pacing and zero extra commentary.`,
            }
          : {
              responseModalities: [Modality.AUDIO],
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              translationConfig: {
                targetLanguageCode: safeTarget,
                echoTargetLanguage: false,
              },
            },
        callbacks: {
          onopen: () => {
            if (!closed && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: 'ready' }));
            }
          },
          onmessage: (message: LiveServerMessage) => {
            if (closed || clientWs.readyState !== WebSocket.OPEN) return;
            const content = message.serverContent;
            if (content?.interrupted) {
              clientWs.send(JSON.stringify({ type: 'interrupted' }));
            }
            if (content?.inputTranscription?.text) {
              clientWs.send(
                JSON.stringify({
                  type: 'inputTranscript',
                  text: content.inputTranscription.text,
                }),
              );
            }
            if (content?.outputTranscription?.text) {
              clientWs.send(
                JSON.stringify({
                  type: 'outputTranscript',
                  text: content.outputTranscription.text,
                }),
              );
            }
            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                clientWs.send(
                  JSON.stringify({ type: 'audio', data: part.inlineData.data }),
                );
              }
            }
          },
          onerror: (err) => {
            if (!closed && clientWs.readyState === WebSocket.OPEN) {
              const formatted = formatApiError(err);
              clientWs.send(
                JSON.stringify({ type: 'error', message: formatted.message }),
              );
            }
          },
          onclose: () => {
            if (!closed && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: 'closed' }));
            }
          },
        },
      });
    } catch (err) {
      const formatted = formatApiError(err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({ type: 'error', message: formatted.message }),
        );
        clientWs.close();
      }
      return;
    }

    clientWs.on('message', (data) => {
      if (!session || closed) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'audio' && typeof msg.data === 'string') {
          session.sendRealtimeInput({
            audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
          });
        }
      } catch {
        // Ignore invalid frame
      }
    });

    clientWs.on('close', () => {
      closed = true;
      try {
        session?.close();
      } catch {
        // Ignore close errors
      }
    });
  });

  // Route WebSocket upgrades cleanly without disturbing Vite HMR/sockets
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/ws/obs') {
      obsWss.handleUpgrade(request, socket, head, (ws) => {
        obsWss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/transcribe') {
      transcribeWss.handleUpgrade(request, socket, head, (ws) => {
        transcribeWss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/live-translate') {
      liveTranslateWss.handleUpgrade(request, socket, head, (ws) => {
        liveTranslateWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Health & status route
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      hasApiKey: Boolean(
        process.env.GEMINI_API_KEY &&
          process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY',
      ),
      ttsModelDefault: 'gemini-3.8-flash-tts',
      obsOverlayClients: obsClients.size,
    });
  });

  // Fast neural translation optimized for live broadcast dubbing (gemini-4-hydrogen)
  app.post('/api/translate', async (req, res) => {
    const { text, sourceLang = 'auto', targetLang = 'ru', context = '' } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Передайте непустой текст для перевода.' });
      return;
    }

    const srcName = LANGUAGE_NAMES[sourceLang] || 'Auto-detected language';
    const tgtName = LANGUAGE_NAMES[targetLang] || 'Russian';

    try {
      const ai = getAiClient();
      const started = Date.now();
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: text.trim(),
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            systemInstruction: [
              `You are a professional live broadcast simultaneous interpreter for OBS livestreams.`,
              `Translate the spoken utterance from ${srcName} into natural, idiomatic spoken ${tgtName} suitable for immediate voice-over dubbing.`,
              `Match the speaker's energy and pacing. Keep the translation concise so it fits the live broadcast slot cleanly.`,
              `Output ONLY the translated spoken text. Do not add quotes, notes, markdown, prefixes, or explanations.`,
              context ? `Broadcast topic context: ${String(context).slice(0, 200)}` : '',
            ]
              .filter(Boolean)
              .join(' '),
          },
        }),
      );

      const translatedText = (response.text ?? '').trim();
      if (!translatedText) {
        res.status(502).json({ error: 'Модель перевода вернула пустой ответ.' });
        return;
      }

      res.json({
        translatedText,
        translateMs: Date.now() - started,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Unary WAV TTS via gemini-3.8-flash-tts (returns complete 24kHz WAV base64)
  app.post('/api/tts', async (req, res) => {
    const {
      text,
      voiceName = 'Kore',
      voiceStyle = 'Уверенный диктор прямого эфира, чистая дикция, живая естественная интонация',
      ttsModel = 'gemini-3.8-flash-tts',
    } = req.body ?? {};

    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Передайте текст для озвучки.' });
      return;
    }

    const safeVoice = ALLOWED_VOICES.has(voiceName) ? voiceName : 'Kore';
    const safeModel = ALLOWED_TTS_MODELS.has(ttsModel)
      ? ttsModel
      : 'gemini-3.8-flash-tts';

    try {
      const ai = getAiClient();
      const started = Date.now();
      const part: { text: string; speechMetadata?: { style: string } } = {
        text: text.trim(),
      };
      if (typeof voiceStyle === 'string' && voiceStyle.trim()) {
        part.speechMetadata = { style: voiceStyle.trim().slice(0, 300) };
      }

      const response = await withRetry(() =>
        ai.models.generateContent({
          model: safeModel,
          contents: [
            {
              role: 'user',
              parts: [part],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: safeVoice },
              },
            },
          },
        }),
      );

      const inlineData =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      const base64Audio = inlineData?.data;

      if (!base64Audio) {
        res.status(502).json({
          error: `Модель ${safeModel} не вернула аудиоданные.`,
        });
        return;
      }

      res.json({
        audioBase64Wav: base64Audio,
        mimeType: inlineData?.mimeType || 'audio/wav',
        ttsMs: Date.now() - started,
        model: safeModel,
        voiceName: safeVoice,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Streaming PCM TTS via gemini-3.8-flash-tts (SSE streaming 24kHz raw L16 PCM)
  app.post('/api/tts/stream', async (req, res) => {
    const {
      text,
      voiceName = 'Kore',
      voiceStyle = 'Уверенный диктор прямого эфира, чистая дикция, живая естественная интонация',
      ttsModel = 'gemini-3.8-flash-tts',
    } = req.body ?? {};

    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Передайте текст для потоковой озвучки.' });
      return;
    }

    const safeVoice = ALLOWED_VOICES.has(voiceName) ? voiceName : 'Kore';
    const safeModel = ALLOWED_TTS_MODELS.has(ttsModel)
      ? ttsModel
      : 'gemini-3.8-flash-tts';

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const started = Date.now();
    try {
      const ai = getAiClient();
      const part: { text: string; speechMetadata?: { style: string } } = {
        text: text.trim(),
      };
      if (typeof voiceStyle === 'string' && voiceStyle.trim()) {
        part.speechMetadata = { style: voiceStyle.trim().slice(0, 300) };
      }

      const stream = await ai.models.generateContentStream({
        model: safeModel,
        contents: [
          {
            role: 'user',
            parts: [part],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: safeVoice },
            },
          },
        },
      });

      let chunkIndex = 0;
      for await (const chunk of stream) {
        const data =
          chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (data) {
          res.write(
            `data: ${JSON.stringify({
              type: 'pcm',
              index: chunkIndex++,
              data,
              elapsedMs: Date.now() - started,
            })}\n\n`,
          );
        }
      }

      res.write(
        `data: ${JSON.stringify({
          type: 'done',
          totalChunks: chunkIndex,
          ttsMs: Date.now() - started,
          model: safeModel,
        })}\n\n`,
      );
      res.end();
    } catch (err) {
      const formatted = formatApiError(err);
      res.write(
        `data: ${JSON.stringify({ type: 'error', error: formatted.message })}\n\n`,
      );
      res.end();
    }
  });

  // Pre-recorded audio clip transcription via gemini-3.5-transcribe
  app.post('/api/transcribe', async (req, res) => {
    const { audioBase64, mimeType = 'audio/webm' } = req.body ?? {};
    if (typeof audioBase64 !== 'string' || !audioBase64) {
      res.status(400).json({ error: 'Передайте аудиофайл в формате base64.' });
      return;
    }

    try {
      const ai = getAiClient();
      const started = Date.now();
      const response = await ai.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: String(mimeType),
                data: audioBase64,
              },
            },
            {
              text: 'Transcribe the spoken speech accurately in its original language. Return only the transcription text without timestamps or commentary.',
            },
          ],
        },
      });

      res.json({
        transcript: (response.text ?? '').trim(),
        transcribeMs: Date.now() - started,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Push subtitle/audio events to all connected OBS Browser Source overlays
  app.post('/api/obs/broadcast', (req, res) => {
    broadcastToObs(req.body ?? {});
    res.json({ ok: true, clients: obsClients.size });
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`DubCast OBS server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start DubCast OBS server:', err);
  process.exit(1);
});
