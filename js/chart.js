// Lightweight Charts (v4) wrapper — main candle chart + equity curve chart.
/* global LightweightCharts */

const DARK = {
  layout: { background: { color: 'transparent' }, textColor: '#9fb0c3' },
  grid: {
    vertLines: { color: 'rgba(255,255,255,0.04)' },
    horzLines: { color: 'rgba(255,255,255,0.04)' },
  },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#26303d' },
  rightPriceScale: { borderColor: '#26303d' },
  crosshair: { mode: 0 },
};

export class MainChart {
  constructor(container) {
    this.chart = LightweightCharts.createChart(container, {
      ...DARK, autoSize: true,
    });
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350',
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      borderVisible: false,
    });
    this.volumeSeries = this.chart.addHistogramSeries({
      priceScaleId: 'vol', priceFormat: { type: 'volume' },
      lastValueVisible: false, priceLineVisible: false,
    });
    this.chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });
    this.overlaySeries = [];
    this.priceLines = [];
  }

  setCandles(candles) {
    this.candleSeries.setData(candles.map(c => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    this.volumeSeries.setData(candles.map(c => ({
      time: c.time, value: c.volume,
      color: c.close >= c.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)',
    })));
  }

  updateLastCandle(c) {
    this.candleSeries.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
    this.volumeSeries.update({
      time: c.time, value: c.volume,
      color: c.close >= c.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)',
    });
  }

  setOverlays(overlays) {
    for (const s of this.overlaySeries) this.chart.removeSeries(s);
    this.overlaySeries = [];
    for (const ov of overlays || []) {
      const s = this.chart.addLineSeries({
        color: ov.color, lineWidth: ov.lineWidth || 1,
        lineStyle: ov.dashed ? 2 : 0,
        priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData(ov.data);
      this.overlaySeries.push(s);
    }
  }

  // trades: backtest trade list; candles for time lookup.
  setTradeMarkers(trades, candles) {
    const markers = [];
    for (const t of trades || []) {
      markers.push({
        time: candles[t.entryIndex].time,
        position: t.side === 'long' ? 'belowBar' : 'aboveBar',
        shape: t.side === 'long' ? 'arrowUp' : 'arrowDown',
        color: t.side === 'long' ? '#26a69a' : '#ef5350',
        text: t.side === 'long' ? 'L' : 'S',
      });
      markers.push({
        time: candles[t.exitIndex].time,
        position: t.side === 'long' ? 'aboveBar' : 'belowBar',
        shape: 'circle',
        color: t.retPct > 0 ? '#ffd54f' : '#78909c',
        text: `${t.retPct > 0 ? '+' : ''}${t.retPct.toFixed(1)}%`,
      });
    }
    markers.sort((a, b) => a.time - b.time);
    this.candleSeries.setMarkers(markers);
  }

  // lines: { entry, tp, sl } prices or null to clear.
  setLiveLines(lines) {
    for (const pl of this.priceLines) this.candleSeries.removePriceLine(pl);
    this.priceLines = [];
    if (!lines) return;
    const defs = [
      { price: lines.entry, color: '#9fb0c3', title: 'ENTRY' },
      { price: lines.tp, color: '#26a69a', title: 'TP' },
      { price: lines.sl, color: '#ef5350', title: 'SL' },
    ];
    for (const d of defs) {
      if (d.price == null) continue;
      this.priceLines.push(this.candleSeries.createPriceLine({
        price: d.price, color: d.color, lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: d.title,
      }));
    }
  }

  fit() { this.chart.timeScale().fitContent(); }
}

export class EquityChart {
  constructor(container) {
    this.chart = LightweightCharts.createChart(container, {
      ...DARK, autoSize: true,
      rightPriceScale: { borderColor: '#26303d' },
    });
    this.series = this.chart.addAreaSeries({
      lineColor: '#40c4ff', lineWidth: 2,
      topColor: 'rgba(64,196,255,0.25)', bottomColor: 'rgba(64,196,255,0.02)',
      priceFormat: { type: 'custom', formatter: v => `${((v - 1) * 100).toFixed(1)}%` },
    });
  }

  // curve: [{time, value}]; splitTime marks the train/test boundary.
  setData(curve, splitTime) {
    this.series.setData(curve);
    if (splitTime != null) {
      this.series.setMarkers([{
        time: splitTime, position: 'aboveBar', shape: 'arrowDown',
        color: '#ffd54f', text: '検証開始',
      }]);
    } else {
      this.series.setMarkers([]);
    }
    this.chart.timeScale().fitContent();
  }
}
