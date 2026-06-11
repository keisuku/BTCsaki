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

1. 起動時に各botのTFで**過去1000本**のkline+**外部指標履歴**(funding 333日/
   L&S比30日/F&G全history)を取得
2. **bot毎の実エントリーロジックを個別に純関数化した19種のレプリカ**
   (js/bot-backtest.js signalsFor)でその場でバックテスト。トレーリング
   ストップ・タイムアウト・%TP/SLまで実機と同型でシミュレート
3. 適応度 = バックテスト×ライブのブレンド(ライブ30トレードまでバックテスト優位)
4. ライブ実績が薄ければ**ロード時にGAを即時3世代実行**(EVOLUTION PROTOCOL演出付き)
5. さらに**グリッド探索**: チャンピオンパラメータ近傍をウォークフォワード
   (70/30)検証し、未知データでも勝てた設定だけをカテゴリ下位botへ直接注入
6. 従来の23:59デイリーGA・4時間毎マイクロPDCA・Hall of Fame・自動昇格はそのまま稼働

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
evolution-boost.js  ★自己改善のバックテスト駆動化+グリッド探索注入(v3)
cockpit-plus.js     ★演出強化: EVOLUTION演出/近接グロー/勝敗バースト/効果音(v3)
cockpit-fx.js       ★演出第2弾: カットイン/シェイク/ソナー/EQUITY RACE(v3)
js/                 バックテストエンジン+19戦略レプリカ+外部指標履歴(純関数)
test/               node test/sanity.mjs && node test/bot-backtest.mjs
                    node test/e2e.mjs (Playwright実機検証: 全APIモック+スクショ)
```

⚠️ シグナル・バックテスト結果は将来の利益を保証しません。投資助言ではありません。
