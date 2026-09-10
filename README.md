# 朝ラン｜セットアップ

```
public/index.html                    画面
netlify/functions/healthplanet.mjs   体組成をタニタから取ってくる
netlify/functions/route.mjs          周回ルートを作る
netlify/functions/ai.mjs             Anthropic API への中継
netlify/functions/data.mjs           記録の読み書き
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

## 3.5. OpenRouteService

https://openrouteservice.org/ の Sign up から HeiGIT アカウントを作ります。
作った時点で無料の Standard キーが付いてくるので、申請や審査はありません。
account.heigit.org のダッシュボードに表示されるキー（`eyJ` で始まる長い文字列）を
Netlify の環境変数 `ORS_API_KEY` に入れて再デプロイ。

毎朝、その日の目標距離に合わせて周回ルートがその場で作られます。
コースの形は2種類あります。

- **周回** … 8本まとめて生成し、実距離が目標±5%のものだけ残し、方角を合わせたうえで
  「進行方向の変化量」が一番小さい＝曲がりの少ないものを選びます。
  経由地は既定3点（`?pts=` で変更可）。増やすほど道が入り組みます。
- **往復** … 指定方角へ目標の半分だけ進んで折り返します。距離のずれを実測から補正して
  折返し地点を詰め直すので、最大3回のリクエストで収束します。迷いようがない形です。

許容誤差は既定±5%（5kmなら±250m）。`?tol=0.03` のように変更できます。

方角は、返ってきた線の重心が起点から見てどちらにあるかを実際に計算して決めます。
ORSのseedはどっちを向くか事前に分からないので、測ってから選ぶ形です。
直近3回に走った方角は記録に残るので、そこから一番離れた方角が優先されます。

## 4. サイト側の設定

APIキーと保存先URLはすべて Netlify の環境変数にあり、ブラウザには出ません。
新しい端末やブラウザでサイトを開いたときに入れるのは **合言葉（APP_TOKEN）だけ** です。
設定は端末ごとに保存されるので、入力は端末につき1回です。

目標体重は npoint 側に保存されるので、どの端末でも共通です。

## 環境変数まとめ

| 変数 | 用途 |
| --- | --- |
| `HP_CLIENT_ID` / `HP_CLIENT_SECRET` | Health Planet アプリ |
| `HP_REFRESH_TOKEN` | Health Planet 認可済みトークン |
| `ORS_API_KEY` | OpenRouteService（account.heigit.org で発行） |
| `ANTHROPIC_API_KEY` | 毎朝の指示とスクショ読み取り |
| `NPOINT_URL` | 記録の保存先（手順1のURL） |
| `APP_TOKEN` | 端末で入力する合言葉。適当なランダム文字列でよい |

環境変数を追加・変更したら、そのつど再デプロイしないと反映されません。

