import { uint8ToBase64 } from './duckingMath';
import { buildObsWsUrl, diagnoseObsWsFailure } from './localModel';

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
 * Supports ws:// and wss://, automatic 127.0.0.1 -> localhost fallback on HTTPS,
 * SHA-256 challenge-response authentication, and actionable error diagnostics.
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
    useTls = false,
  ): Promise<string[]> {
    this.disconnect();
    const isHttpsPage =
      typeof window !== 'undefined' && window.location.protocol === 'https:';
    const isInIframe =
      typeof window !== 'undefined' && window.self !== window.top;

    // On HTTPS pages, Chromium exempts ws://localhost from Mixed Content but often blocks ws://127.0.0.1.
    const candidates: string[] = [buildObsWsUrl(host, port, useTls)];
    if (
      !useTls &&
      host.trim() === '127.0.0.1' &&
      !candidates.includes(`ws://localhost:${port}`)
    ) {
      candidates.push(`ws://localhost:${port}`);
    }

    let lastError = '';
    for (let i = 0; i < candidates.length; i++) {
      const wsUrl = candidates[i];
      try {
        return await this.connectSingle(wsUrl, password, {
          host,
          port,
          useTls,
          isHttpsPage,
          isInIframe,
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // If auth failed (4009), don't retry alternate host
        if (lastError.includes('4009')) {
          break;
        }
      }
    }

    this.setState('error', lastError);
    throw new Error(lastError);
  }

  private connectSingle(
    wsUrl: string,
    password: string,
    meta: {
      host: string;
      port: number;
      useTls: boolean;
      isHttpsPage: boolean;
      isInIframe: boolean;
    },
  ): Promise<string[]> {
    this.setState('connecting', `Подключение к ${wsUrl}…`);

    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        const msg = diagnoseObsWsFailure({
          ...meta,
          isSecurityError: true,
        });
        reject(new Error(msg));
        return;
      }
      this.ws = ws;

      const fail = (msg: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(msg));
        }
      };

      const timeout = window.setTimeout(() => {
        try {
          ws.close();
        } catch {
          // Ignore
        }
        fail(
          diagnoseObsWsFailure({
            ...meta,
            closeCode: 1006,
          }),
        );
      }, 4000);

      ws.onerror = () => {
        // Wait briefly for onclose to deliver exact closeCode (e.g. 4009 vs 1006)
      };

      ws.onclose = (ev) => {
        window.clearTimeout(timeout);
        if (this.state === 'connected') {
          this.setState('disconnected', 'Соединение с OBS закрыто.');
        } else if (!settled) {
          fail(
            diagnoseObsWsFailure({
              ...meta,
              closeCode: ev.code,
            }),
          );
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
            this.setState('connected', `Подключено к OBS Studio (${wsUrl})`);
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
