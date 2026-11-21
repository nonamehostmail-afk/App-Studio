import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLocalChatEndpoint,
  buildLocalModelsEndpoint,
  buildLocalTranslateRequest,
  buildObsWsUrl,
  diagnoseObsWsFailure,
  extractLocalTranslationText,
  parseLocalModelList,
  stripThinkTags,
} from './localModel';

test('buildLocalChatEndpoint and buildLocalModelsEndpoint support Ollama and OpenAI-compatible servers', () => {
  assert.equal(
    buildLocalChatEndpoint('http://localhost:11434/', 'ollama'),
    'http://localhost:11434/api/chat',
  );
  assert.equal(
    buildLocalModelsEndpoint('localhost:11434', 'ollama'),
    'http://localhost:11434/api/tags',
  );
  assert.equal(
    buildLocalChatEndpoint('http://localhost:1234', 'openai'),
    'http://localhost:1234/v1/chat/completions',
  );
  assert.equal(
    buildLocalChatEndpoint('http://localhost:1234/v1', 'openai'),
    'http://localhost:1234/v1/chat/completions',
  );
  assert.equal(
    buildLocalModelsEndpoint('http://localhost:1234/v1', 'openai'),
    'http://localhost:1234/v1/models',
  );
});

test('extractLocalTranslationText handles Ollama, OpenAI, and reasoning <think> tags cleanly', () => {
  assert.equal(
    stripThinkTags('<think>internal reasoning</think>\nДобро пожаловать в эфир!'),
    'Добро пожаловать в эфир!',
  );
  assert.equal(
    extractLocalTranslationText('ollama', {
      message: { content: '<think>ok</think>Привет всем зрителям!' },
    }),
    'Привет всем зрителям!',
  );
  assert.equal(
    extractLocalTranslationText('openai', {
      choices: [{ message: { content: 'Начинаем трансляцию.' } }],
    }),
    'Начинаем трансляцию.',
  );
});

test('buildLocalTranslateRequest and parseLocalModelList structure payloads correctly', () => {
  const req = buildLocalTranslateRequest({
    protocol: 'ollama',
    modelName: 'qwen2.5:7b',
    text: 'Hello stream!',
    sourceLangName: 'English',
    targetLangName: 'Russian',
  });
  assert.equal(req.model, 'qwen2.5:7b');
  assert.equal(req.stream, false);

  assert.deepEqual(
    parseLocalModelList('ollama', {
      models: [{ name: 'qwen2.5:7b' }, { name: 'gemma3:4b' }],
    }),
    ['qwen2.5:7b', 'gemma3:4b'],
  );
  assert.deepEqual(
    parseLocalModelList('openai', {
      data: [{ id: 'lmstudio-community/Meta-Llama-3.1-8B' }],
    }),
    ['lmstudio-community/Meta-Llama-3.1-8B'],
  );
});

test('buildObsWsUrl and diagnoseObsWsFailure handle localhost, wss, 4009 auth, and HTTPS iframe blocks', () => {
  assert.equal(buildObsWsUrl('localhost', 4455, false), 'ws://localhost:4455');
  assert.equal(buildObsWsUrl('obs.example.com', 4455, true), 'wss://obs.example.com:4455');
  assert.equal(
    buildObsWsUrl('wss://tunnel.example.com/obs', 4455, false),
    'wss://tunnel.example.com/obs',
  );

  const authMsg = diagnoseObsWsFailure({
    closeCode: 4009,
    host: 'localhost',
    port: 4455,
    useTls: false,
    isHttpsPage: true,
    isInIframe: true,
  });
  assert.match(authMsg, /4009/);
  assert.match(authMsg, /пароль/i);

  const iframeMsg = diagnoseObsWsFailure({
    closeCode: 1006,
    host: '127.0.0.1',
    port: 4455,
    useTls: false,
    isHttpsPage: true,
    isInIframe: true,
  });
  assert.match(iframeMsg, /Browser Source/);
});
