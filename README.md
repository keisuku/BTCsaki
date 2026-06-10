# BTCsaki — バックテスト駆動シグナルチャート

人気シグナル戦略10種(Supertrend / UT Bot Alerts / Squeeze Momentum / EMAクロス / MACD+RSI / ボリンジャー逆張り / VWAP回帰 / Donchianブレイク / Heikin-Ashi / Chandelier Exit)を、起動のたびに Binance の最新データでバックテスト&ウォークフォワード検証し、**いま最も勝てている「チャンピオンbot」を自動選抜**。そのトレードをチャート上に可視化し、真似してエントリーできるダッシュボード。

## 使い方

静的ホスティング(GitHub Pages等)に置くか、ローカルで:

```
python3 -m http.server 8000
# → http://localhost:8000
```

サーバー・APIキー・ビルド不要。データは Binance Public API から直接取得。

## 仕組み

1. 起動時に各コイン×時間足の直近1500本を取得
2. 10戦略 × パラメータグリッド × エグジット6種 = 276通りをその場でバックテスト(Web Worker、数百ms)
3. 前半70%で最適化 → 後半30%(未知データ)で検証。検証成績が基準(トレード8回以上・PnL>0・PF>1)を満たす最良構成がチャンピオン
4. チャンピオンの現在ポジションをライブ判定し、LONG/SHORT/WAIT + エントリー/TP/SL を表示
5. 30分ごと&再訪時に最新データで自動再選抜(=自己改善)

バックテストは次足始値エントリー・SL優先判定・手数料往復0.08%控除の保守的設計。

## 構成

```
index.html        シェル(Lightweight Charts CDN)
js/config.js      設定
js/data.js        Binance REST
js/indicators.js  指標(純関数)
js/strategies.js  10戦略 + パラメータグリッド
js/backtest.js    バックテストエンジン
js/optimizer.js   グリッドサーチ + ウォークフォワード
js/worker.js      Web Worker
js/chart.js       Lightweight Charts ラッパー
js/ui.js          DOM描画
js/app.js         オーケストレータ
```

## 検証

```
node test/sanity.mjs  # 合成データで指標/戦略/エンジン/オプティマイザを検証
```

⚠️ バックテスト結果は将来の利益を保証しません。投資助言ではありません。
