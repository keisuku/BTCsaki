// Module Worker: receives klines, runs the optimizer off the main thread.
import { optimize } from './optimizer.js';

self.onmessage = (e) => {
  const { id, candles } = e.data;
  try {
    const result = optimize(candles, (done, total, name) => {
      self.postMessage({ id, type: 'progress', done, total, name });
    });
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message || err) });
  }
};
