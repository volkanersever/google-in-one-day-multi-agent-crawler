// Singleton EventEmitter — crawler emits, server (SSE) subscribes.
import { EventEmitter } from 'node:events';

class CrawlerBus extends EventEmitter {}
const bus = new CrawlerBus();
bus.setMaxListeners(100);

export { bus };
