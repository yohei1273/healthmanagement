# 朝ラン｜セットアップ

```
public/index.html                    画面（これ1枚）
netlify/functions/healthplanet.mjs   タニタ体組成
netlify/functions/strava.mjs         Strava（NRCの受け皿）
netlify.toml
```

Functions を使うので、フォルダのドラッグ&ドロップではなく **GitHub のリポジトリを
Netlify に繋いで**デプロイしてください。ビルドコマンドは空、公開ディレクトリは `public`。

---

## 1. Health Planet

1. https://www.healthplanet.jp/apis_account.do で新規登録
   - アプリケーションタイプは「クライアントアプリケーション」
   - クライアントIDとクライアントシークレットが発行される
2. Netlify の環境変数に `HP_CLIENT_ID` と `HP_CLIENT_SECRET` を入れてデプロイ
3. ブラウザで認可画面を開いてアクセスを許可し、表示された認可コードを控える

```
https://www.healthplanet.jp/oauth/auth?client_id=<クライアントID>&redirect_uri=https://www.healthplanet.jp/success.html&scope=innerscan&response_type=code
```

4. 認可コードを refresh_token に交換する

```
https://<あなたのサイト>/.netlify/functions/healthplanet?action=exchange&code=<認可コード>
```

5. 返ってきた `refresh_token` を環境変数 `HP_REFRESH_TOKEN` に入れて再デプロイ

以降はサイトの「今日のデータを取り込む」だけで体重・体脂肪率・筋肉量・基礎代謝などが入ります。
アクセストークンは毎回リフレッシュするので、30日で切れる心配はありません。
まれに refresh_token が更新された場合は画面に新しい値が出るので、環境変数を貼り替えてください。

## 2. Strava（Nike Run Club の受け皿）

まず NRC アプリで **プロフィール > 設定 > パートナー > Strava** を繋ぎます。
これで以降のランが自動で Strava に入ります（過去分は同期されません）。

1. https://www.strava.com/settings/api でアプリを作成（無料）
2. `STRAVA_CLIENT_ID` と `STRAVA_CLIENT_SECRET` を環境変数に
3. 認可URLを開いて許可し、リダイレクト先URLの `code=` を控える

```
https://www.strava.com/oauth/authorize?client_id=<ID>&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=activity:read_all
```

4. 交換する

```
https://<あなたのサイト>/.netlify/functions/strava?action=exchange&code=<コード>
```

5. `refresh_token` を `STRAVA_REFRESH_TOKEN` に入れて再デプロイ

## 3. サイト側

設定タブで入れるもの:

- 目標体重（初期値 60kg）
- Anthropic APIキー — 毎朝の指示とスクショ読み取りに使う
- npoint.io の JSON URL — 記録とルート台帳の保存先
- OpenRouteService のキーはルート生成時に都度入力

## 環境変数まとめ

| 変数 | 用途 |
| --- | --- |
| `HP_CLIENT_ID` / `HP_CLIENT_SECRET` | Health Planet アプリ |
| `HP_REFRESH_TOKEN` | Health Planet 認可済みトークン |
| `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` | Strava アプリ |
| `STRAVA_REFRESH_TOKEN` | Strava 認可済みトークン |
