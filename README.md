# BTCsaki — BTC先物スキャルシグナル・サイバーコックピット

ネオンダークのリアルタイムダッシュボード。15体以上のAI botが1〜3秒間隔でガチャガチャ稼働し、
エントリー間近の予兆・実際のエントリー・勝った負けたが演出付きで一目で分かる。
botのトレードを真似してスキャルピングするための「作戦司令室」。

## 主要パネル

- 総合シグナルダイヤル(LONG/SHORT/WAIT、0-100スコア)+ 5段階レベルピル
- 5TF(5m/15m/1h/4h/1d)シグナルマトリクス、エントリータイミングリング
- **Bot Arena**: 15+体のbotカード(watching/ready/holding、含み損益、TP/SL、勝率)
- 作戦司令室ストリップ(稼働ポジ数・艦隊含み損益・本日戦績・連勝コンボ・GA世代)
- チャートオーバーレイ(出来高プロファイル、清算クラスタ、botエントリーマーカー、CVD)
- MetaBot(Top5アンサンブル)、スマートアドバイス、ニュースティッカー

## 自己改善(バックテスト駆動 — v3で修理済み)

旧来はブラウザを開いている間のpaper tradeだけが進化の材料で、GAが実質空転していた。
現在は:

1. 起動時に各botのTFで**過去1000本**のklineを取得
2. 各botのパラメータを**その場でバックテスト**(js/bot-backtest.js — computeTFの
   価格系スコアを純関数で複製。FR/L&S/F&Gは履歴が無いため除外。適応度の
   順位付けには十分)
3. 適応度 = バックテスト×ライブのブレンド(ライブ30トレードまでバックテスト優位)
4. ライブ実績が薄ければ**ロード時にGAを即時3世代実行**(EVOLUTION PROTOCOL演出付き)
5. 従来の23:59デイリーGA・4時間毎マイクロPDCA・Hall of Fame・自動昇格はそのまま稼働

## 使い方

静的ホスティング(GitHub Pages等)に置くか、ローカルで:

```
python3 -m http.server 8000   # → http://localhost:8000
```

サーバー・APIキー不要。データはBinance Public API / alternative.me。

## 構成

```
index.html          本体(コックピットUI + bot arena + GA)
realtime-plus.js    CVD/DOM/真デルタ
evolution-plus.js   PDCA/Hall of Fame/自動昇格
signal-booster.js   CVD/DOMシグナル注入
arena-plus.js       チャートオーバーレイ/エクイティ
metabot.js          Top5アンサンブル
smart-advice.js     統合アドバイス
evolution-boost.js  ★自己改善のバックテスト駆動化(v3)
cockpit-plus.js     ★演出強化: EVOLUTION演出/近接グロー/勝敗バースト/効果音(v3)
js/                 バックテストエンジン(純関数ライブラリ)
test/               node test/sanity.mjs && node test/bot-backtest.mjs
```

⚠️ シグナル・バックテスト結果は将来の利益を保証しません。投資助言ではありません。
