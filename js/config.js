// Global configuration — coins, timeframes, fees, optimization settings.

export const COINS = {
  BTC: { symbol: 'BTCUSDT', name: 'Bitcoin', precision: 1 },
  ETH: { symbol: 'ETHUSDT', name: 'Ethereum', precision: 2 },
  XRP: { symbol: 'XRPUSDT', name: 'XRP', precision: 4 },
  SOL: { symbol: 'SOLUSDT', name: 'Solana', precision: 2 },
};

export const TIMEFRAMES = ['5m', '15m', '1h', '4h'];

export const DEFAULT_COIN = 'BTC';
export const DEFAULT_TF = '15m';

// Binance taker fee per side (0.04%). Round trip = 0.08%.
export const FEE_PER_SIDE = 0.0004;

// Historical klines fetched per optimization run.
export const KLINE_LIMIT = 1500;

// Walk-forward split: optimize on first 70%, validate on last 30%.
export const TRAIN_RATIO = 0.7;

// Champion guards (validation set).
export const MIN_TEST_TRADES = 8;

// Shared exit grid: ATR(14) multiples for stop-loss / take-profit.
export const EXIT_GRID = [
  { slAtr: 1.0, tpAtr: 1.5 },
  { slAtr: 1.0, tpAtr: 2.0 },
  { slAtr: 1.0, tpAtr: 3.0 },
  { slAtr: 1.5, tpAtr: 1.5 },
  { slAtr: 1.5, tpAtr: 2.0 },
  { slAtr: 1.5, tpAtr: 3.0 },
];

export const ATR_EXIT_PERIOD = 14;

// Live polling interval per timeframe (ms).
export const POLL_MS = { '5m': 15000, '15m': 15000, '1h': 60000, '4h': 60000 };

// Re-optimize while tab is open (ms).
export const REOPTIMIZE_MS = 30 * 60 * 1000;

export const STORAGE_PREFIX = 'btcsaki_v2';
