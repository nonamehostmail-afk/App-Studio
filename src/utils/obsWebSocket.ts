import { uint8ToBase64 } from './duckingMath';

export type ObsConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

async function sha256Base64(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return uint8ToBase64(new Uint8Array(hash));
}

/**
 * Real OBS WebSocket v5 client (OBS Studio 28+ built-in WebSocket Server).
 * Allows automatic remote muting/ducking of any OBS audio input source when
 * Gemini 3.8 Flash TTS translation audio plays.
 */
export class ObsWebSocketClient {
  private ws: WebSocket | null = null;
  private reqCounter = 0;
  private pending = new Map<string, PendingRequest>();
  private state: ObsConnectionState = 'disconnected';
  private onStateChange?: (state: ObsConnectionState, message?: string) => void;

  constructor(
    onStateChange?: (state: ObsConnectionState, message?: string) => void,
  ) {
    this.onStateChange = onStateChange;
  }

  public getState(): ObsConnectionState {
    return this.state;
  }

  private setState(state: ObsConnectionState, message?: string) {
    this.state = state;
    this.onStateChange?.(state, message);
  }

  public async connect(
    host: string,
    port: number,
    password: string,
  ): Promise<string[]> {
    this.disconnect();
    this.setState('connecting', `Подключение к ws://${host}:${port}...`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(`ws://${host}:${port}`);
      this.ws = ws;

      const fail = (msg: string) => {
        if (!settled) {
          settled = true;
          this.setState('error', msg);
          reject(new Error(msg));
        }
      };

      const timeout = window.setTimeout(() => {
        ws.close();
        fail(
          'Таймаут подключения к OBS WebSocket. Убедитесь, что OBS Studio запущен и сервер WebSocket включён (Инструменты → Настройки сервера WebSocket).',
        );
      }, 4500);

      ws.onerror = () => {
        window.clearTimeout(timeout);
        fail(
          'Не удалось подключиться к OBS WebSocket. Проверьте порт 4455 и убедитесь, что OBS запущен локально.',
        );
      };

      ws.onclose = () => {
        window.clearTimeout(timeout);
        if (this.state === 'connected') {
          this.setState('disconnected', 'Соединение с OBS закрыто.');
        } else if (!settled) {
          fail('OBS WebSocket отклонил соединение.');
        }
        for (const [, p] of this.pending) {
          p.reject(new Error('Соединение с OBS закрыто'));
        }
        this.pending.clear();
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          const op = msg.op;

          // Op 0: Hello -> send Op 1 Identify with optional SHA-256 auth
          if (op === 0) {
            let authentication: string | undefined;
            const authInfo = msg.d?.authentication;
            if (authInfo?.challenge && authInfo?.salt) {
              const secret = await sha256Base64(password + authInfo.salt);
              authentication = await sha256Base64(secret + authInfo.challenge);
            }
            ws.send(
              JSON.stringify({
                op: 1,
                d: {
                  rpcVersion: 1,
                  ...(authentication ? { authentication } : {}),
                },
              }),
            );
          }

          // Op 2: Identified
          if (op === 2) {
            window.clearTimeout(timeout);
            settled = true;
            this.setState('connected', 'Подключено к OBS Studio WebSocket v5');
            try {
              const inputs = await this.getInputNames();
              resolve(inputs);
            } catch {
              resolve([]);
            }
          }

          // Op 7: RequestResponse
          if (op === 7 && msg.d?.requestId) {
            const req = this.pending.get(msg.d.requestId);
            if (req) {
              this.pending.delete(msg.d.requestId);
              if (msg.d.requestStatus?.result) {
                req.resolve(msg.d.responseData || {});
              } else {
                req.reject(
                  new Error(
                    msg.d.requestStatus?.comment || 'OBS request failed',
                  ),
                );
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      };
    });
  }

  public disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }
    this.setState('disconnected');
  }

  private sendRequest(
    requestType: string,
    requestData?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OBS WebSocket не подключён'));
    }
    const requestId = `dubcast-${++this.reqCounter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.ws?.send(
        JSON.stringify({
          op: 6,
          d: { requestType, requestId, requestData },
        }),
      );
    });
  }

  public async getInputNames(): Promise<string[]> {
    const res = await this.sendRequest('GetInputList');
    const inputs = (res.inputs as Array<{ inputName?: string }>) || [];
    return inputs
      .map((i) => i.inputName)
      .filter((name): name is string => Boolean(name));
  }

  public async setInputMute(inputName: string, muted: boolean): Promise<void> {
    if (!inputName.trim() || this.state !== 'connected') return;
    await this.sendRequest('SetInputMute', {
      inputName,
      inputMuted: muted,
    });
  }

  public async setInputVolumeDb(
    inputName: string,
    inputVolumeDb: number,
  ): Promise<void> {
    if (!inputName.trim() || this.state !== 'connected') return;
    await this.sendRequest('SetInputVolume', {
      inputName,
      inputVolumeDb,
    });
  }
}
