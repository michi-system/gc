# Always-On Deploy

`gc.azus.tokyo` を完全に常設するなら、ローカル Mac と Cloudflare tunnel 依存をやめて、常時稼働のホストへ移す必要があります。

この repo には Render 向けの Blueprint を追加しています。

## 追加済みファイル

- `render.yaml`
- `greenfield/Dockerfile`
- `greenfield/.dockerignore`

## 推奨構成

- Render Web Service
- Docker runtime
- Persistent Disk
- Custom Domain: `gc.azus.tokyo`

## Render 側で入れる値

- `BASE_URL=https://gc.azus.tokyo`
- `GC_GREENFIELD_DATA_DIR=/var/data/gc-greenfield`
- `GC_GREENFIELD_CHROME_PATH=/usr/bin/chromium`
- `GC_GREENFIELD_SESSION_SECRET` は Render に生成させる

## Google OAuth

Google Cloud Console 側では `Web application` の OAuth client を使い、redirect URI をこれにします。

`https://gc.azus.tokyo/auth/google/callback`

client JSON はアプリ内設定で登録するか、初回ログイン後にアップロードします。

## デプロイ後にやること

1. Render で repo `michi-system/gc` を Blueprint deploy
2. `gc.azus.tokyo` を Render service に custom domain として追加
3. Cloudflare DNS を Render 側の案内に合わせて更新
4. Google OAuth redirect URI を `https://gc.azus.tokyo/auth/google/callback` に設定
5. ログイン -> Gmail 接続 -> Calendar 接続を確認
