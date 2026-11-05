import { registerPlugin, type Plugin, type PluginListenerHandle } from '@capacitor/core';

type ResponseEvent = { requestId: string; status: number; headers?: Record<string, string> };
type ChunkEvent = { requestId: string; base64: string };
type RequestEvent = { requestId: string; message?: string };

interface StreamPlugin extends Plugin {
  start(options: { requestId: string; url: string; method: string; headers: Record<string, string>; body?: string }): Promise<void>;
  cancel(options: { requestId: string }): Promise<void>;
  addListener(eventName: 'response', listener: (event: ResponseEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'chunk', listener: (event: ChunkEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'complete', listener: (event: RequestEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'error', listener: (event: RequestEvent) => void): Promise<PluginListenerHandle>;
}

const nativePlugin = registerPlugin<StreamPlugin>('OpenCodeGoStream');
let sequence = 0;

function decodeChunk(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

/** Fetch-compatible native HTTP with incremental chunks and cancellable requests. */
export function createOpenCodeGoNativeFetch(plugin: StreamPlugin = nativePlugin): typeof fetch {
  return async (resource, init) => {
    const request = resource instanceof Request ? resource : undefined;
    const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
    const method = (init?.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(init?.headers || request?.headers);
    const body = init?.body ?? (request && method !== 'GET' && method !== 'HEAD' ? await request.clone().text() : undefined);
    if (body != null && typeof body !== 'string') throw new TypeError('Native OpenCode Go only accepts text request bodies');
    const signal = init?.signal || request?.signal;
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

    const requestId = `sully-go-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let receivedResponse = false;
    let finished = false;
    let pendingError: Error | undefined;
    const pendingChunks: Uint8Array[] = [];
    const handles: PluginListenerHandle[] = [];
    let resolveResponse!: (event: ResponseEvent) => void;
    let rejectResponse!: (error: Error) => void;
    const responsePromise = new Promise<ResponseEvent>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    let abortHandler: (() => void) | undefined;
    const cleanup = () => {
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
      void Promise.all(handles.map(handle => handle.remove()));
    };
    const fail = (error: Error) => {
      if (!receivedResponse) rejectResponse(error);
      else if (controller) controller.error(error);
      else pendingError = error;
      cleanup();
    };

    try {
      handles.push(await plugin.addListener('response', event => {
        if (event.requestId !== requestId || receivedResponse) return;
        receivedResponse = true;
        resolveResponse(event);
      }));
      handles.push(await plugin.addListener('chunk', event => {
        if (event.requestId !== requestId) return;
        const bytes = decodeChunk(event.base64);
        if (controller) controller.enqueue(bytes);
        else pendingChunks.push(bytes);
      }));
      handles.push(await plugin.addListener('complete', event => {
        if (event.requestId !== requestId) return;
        finished = true;
        if (controller) controller.close();
        cleanup();
      }));
      handles.push(await plugin.addListener('error', event => {
        if (event.requestId === requestId) fail(new TypeError(event.message || 'Native OpenCode Go request failed'));
      }));
      abortHandler = () => {
        void plugin.cancel({ requestId });
        fail(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', abortHandler, { once: true });
      await plugin.start({
        requestId,
        url,
        method,
        headers: Object.fromEntries(headers.entries()),
        ...(body != null ? { body } : {}),
      });
      const metadata = await responsePromise;
      if ([204, 205, 304].includes(metadata.status)) {
        cleanup();
        return new Response(null, { status: metadata.status, headers: metadata.headers || {} });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
          while (pendingChunks.length) controller.enqueue(pendingChunks.shift()!);
          if (pendingError) controller.error(pendingError);
          else if (finished) controller.close();
        },
        cancel() {
          void plugin.cancel({ requestId });
          cleanup();
        },
      });
      return new Response(stream, { status: metadata.status, headers: metadata.headers || {} });
    } catch (error) {
      void plugin.cancel({ requestId });
      cleanup();
      throw error;
    }
  };
}
