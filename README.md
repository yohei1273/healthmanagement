# 朝ラン｜セットアップ

```
public/index.html                    画面
netlify/functions/healthplanet.mjs   体組成をタニタから取ってくる
netlify.toml
```

Functions を使うので、GitHub のリポジトリを Netlify に繋いでデプロイします。
ビルドコマンドは空、公開ディレクトリは `public`。

## データの流れ

```
タニタ体組成計 → ヘルスプラネット → healthplanet関数 → サイト（ボタン1つ）
Nike Run Club → 結果画面のスクショ → Claudeが読み取り → フォームに自動入力
```

体組成の9項目は自動、ランはスクショ1枚。Strava は 2026年6月から
Standard Tier の開発者にサブスクリプションを要求するようになったので使いません。

---

## 1. npoint.io

https://www.npoint.io/ で新しいビンを作り、中身を `{"records":[],"routes":[]}` にして保存。
発行される API URL（`https://api.npoint.io/xxxxxxxx`）を控えます。

## 2. Health Planet

1. https://www.healthplanet.jp/apis_account.do で新規登録
   - アプリケーションタイプは **クライアントアプリケーション**
   - ホストドメインには Netlify のドメイン（`xxxx.netlify.app`）
2. Netlify の環境変数に `HP_CLIENT_ID` と `HP_CLIENT_SECRET` を入れてデプロイ
3. 認可画面を開いてアクセスを許可し、表示された認可コードを控える

```
https://www.healthplanet.jp/oauth/auth?client_id=<クライアントID>&redirect_uri=https://www.healthplanet.jp/success.html&scope=innerscan&response_type=code
```

4. 認可コードを refresh_token に交換

```
https://<サイト>/.netlify/functions/healthplanet?action=exchange&code=<認可コード>
```

5. `refresh_token` を環境変数 `HP_REFRESH_TOKEN` に入れて再デプロイ

## 3. ランの記録

Nike Run Club で走り終わったら、結果画面のスクリーンショットを撮っておきます。
サイトの記録タブ >「ランのスクショを読む」で画像を選んで読み取るを押すと、
距離・時間・平均ペース・消費カロリー・高低差・ピッチが自動でフォームに入ります。

体組成のボタンと合わせて、朝の操作は「体組成を取り込む → スクショを読む →
きつさを選ぶ → 保存」の4アクションです。

## 4. サイト側の設定

設定タブで入れるもの（端末に保存されるので初回だけ）:

- 目標体重（60kg）
- Anthropic APIキー — 毎朝の指示とスクショ読み取り用
- Netlify Functions のベースURL — 既定の `/.netlify/functions` のままでOK
- npoint.io の URL — 手順1のもの

OpenRouteService のキーはルート生成のときだけ都度入力します。

## 環境変数まとめ

| 変数 | 用途 |
| --- | --- |
| `HP_CLIENT_ID` / `HP_CLIENT_SECRET` | Health Planet アプリ |
| `HP_REFRESH_TOKEN` | Health Planet 認可済みトークン |

環境変数を追加・変更したら、そのつど再デプロイしないと反映されません。

