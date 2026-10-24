import { EventEmitter } from 'node:events';
import type { LiveEvent } from '@shipyard/shared';

/** In-process pub/sub that fans server state changes out to SSE clients. */
class LiveBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish(event: LiveEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}

export const bus = new LiveBus();
