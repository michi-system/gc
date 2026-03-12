# GC Local Automation

Google Calendar と Gmail を参照して、オンライン塾向けの業務申請フォーム下書きをローカルで管理するツールです。フォーム送信は自動化せず、Google Forms への自動入力後にユーザーが最終確認して手動送信します。生徒台帳はアプリ内で完全手動管理です。

## Scope

- `作業時間報告-2025年度`
- `コーチング日程変更フォーム`
- `引き継ぎフォーム`

## Architecture

- `src/server.ts`
  - Express API
  - Google OAuth
  - Calendar / Gmail sync
  - task generation and audit
- `public/`
  - macOS 風のローカルダッシュボード
  - 見取りサマリー / 未処理 / 一覧 / カレンダー / 設定
- `tampermonkey-autofill.user.js`
  - `localhost` から draft task を受け取る
  - Google Forms の visible fields を自動入力する
  - 必要なら次ページへ進む
  - `送信` は押さず、送信直前で止まる
- `src-tauri/`
  - Mac アプリ用の Tauri shell
  - 開発中は `http://127.0.0.1:3131` をそのまま表示
  - release bundle では同梱済み `dist/` と `public/` を使ってローカル backend を起動
  - `node-sidecar` を app に同梱し、ユーザー環境の Node.js に依存しない

## Setup

1. 依存関係を入れる

```bash
npm install
```

2. Google OAuth client JSON を配置する

```text
.local/oauth/client_secret.json
```

3. 開発サーバーを起動する

```bash
npm run dev
```

4. Tampermonkey に以下を読み込む

```text
/Users/tadamichikimura/Downloads/dev-HQ/gc/tampermonkey-autofill.user.js
```

5. ダッシュボードを開く

```text
http://127.0.0.1:3131
```

6. 設定画面で以下を保存する

- Google OAuth credentials path
- coach profile
  - default name: `預忠道`
  - default coach code: `gco0491`
  - email は未設定なので入力が必要
- target calendars
- Gmail queries
- student roster

7. `Google を接続` を押して OAuth を完了する

8. `同期を実行` を押す

## Mac App

Web ダッシュボードの代わりに Mac アプリとして開発する場合:

```bash
npm run tauri:dev
```

debug bundle を作る:

```bash
npm run tauri:build -- --debug
```

release bundle を作る:

```bash
npm run tauri:build
```

ad-hoc 署名でローカル配布確認だけしたい場合:

```bash
npm run tauri:build:adhoc
```

このコマンドは build 後に `.app` と `.dmg` を ad-hoc で再署名します。

Developer ID 署名 + notarization 前提で release を作る場合:

```bash
npm run tauri:build:signed
```

事前チェックだけ走らせたい場合:

```bash
npm run check:macos-release
```

Keychain に入っている code signing identity を見る:

```bash
npm run macos:identities
```

release bundle の署名 / Gatekeeper / stapler を検証する:

```bash
npm run verify:macos-release
```

生成物:

- App bundle: `src-tauri/target/release/bundle/macos/GC Console.app`
- DMG: `src-tauri/target/release/bundle/dmg/GC Console_0.1.0_aarch64.dmg`

注意:

- 現在の release app は `node-sidecar` を app に同梱して backend を起動します。Node.js を別途入れる必要はありません。
- notarization には Apple 側の資格情報が必要です。次のどちらかを設定してください。
  - App Store Connect API key:
    - `APPLE_API_ISSUER`
    - `APPLE_API_KEY`
    - `APPLE_API_KEY_PATH`
  - Apple ID:
    - `APPLE_ID`
    - `APPLE_PASSWORD`
    - `APPLE_TEAM_ID`
- Developer ID 署名には `Developer ID Application` 証明書が必要です。明示したい場合は `APPLE_SIGNING_IDENTITY` を使ってください。
- 環境変数の雛形は `.env.macos-release.example` に置いてあります。
- 実際の配布前には code signing / notarization / stapling の確認が必要です。
- `verify:macos-release` は次をまとめて見ます。
  - `codesign -dv`
  - `codesign --verify`
  - `spctl -a -vv -t exec`
  - `xcrun stapler validate`
- ad-hoc build では `codesign --verify` は通りますが、`Gatekeeper` と `stapler` は落ちるのが正常です。

## GitHub Distribution

Apple Developer Program に入っていない前提では、現実的な配布先は GitHub Releases です。

ローカルで GitHub 配布用 assets を作る:

```bash
npm run github:release:prepare
```

生成物:

- `release/github/GC Console_0.1.0_macOS.dmg`
- `release/github/GC Console_0.1.0_macOS.zip`
- `release/github/INSTALL_MAC.md`
- `release/github/SHA256SUMS.txt`

GitHub Actions:

- `.github/workflows/release-macos.yml`
- `v*` タグ push で GitHub Release に asset を添付
- `workflow_dispatch` では artifact として出力

ユーザー向けの前提:

- notarization なし配布なので、初回起動時に macOS の警告が出る
- `INSTALL_MAC.md` に `右クリックして開く` と `Open Anyway` の案内を同梱する

## Local Data

- SQLite: `.local/app.db`
- OAuth token: `.local/oauth/tokens.json`
- OAuth client JSON: `.local/oauth/client_secret.json`

## Flow

1. Calendar / Gmail を同期する
2. 差分から task を作る
3. 未処理 / 詳細パネルで不足項目を補完する
4. `フォームを開く` を押す
5. userscript がフォーム入力を自動で進める
6. `内容確認後に手動送信してください` バナーが出たら内容確認して送信する
7. 次回同期時に Gmail の回答コピーで `submitted_confirmed` へ更新する

## Verification

```bash
npm run typecheck
npm test
cargo check --manifest-path src-tauri/Cargo.toml
```
