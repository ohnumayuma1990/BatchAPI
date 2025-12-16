# Cloudflare Batch Prompt Console

OpenAI Responses API (Batch API) を利用した、大量のプロンプトを一括実行・管理するためのサーバーレスアプリケーションです。

## 特徴
- **Batch API 対応**: OpenAI の Batch API を利用して、非同期で大量のプロンプトを安価に処理。
- **ステータス管理**: Cloudflare Durable Objects を使用して、各プロンプトの実行状態（未実行、キュー待ち、実行中、完了、失敗）を永続化・追跡。
- **自動同期**: アプリケーションを開いたり更新ボタンを押すと、OpenAI側の最新の進捗状況と自動同期。
- **結果の簡単取得**: 完了したバッチの結果（JSONL）を自動取得し、回答テキストのみを抽出して表示・コピー可能。
- **CSVアップロード**: CSVファイルから一括でプロンプトを登録可能。

## 技術スタック
- **Frontend**: React + TypeScript + Vite
- **Backend**: Cloudflare Workers
- **Database**: Cloudflare Durable Objects (SQLite)
- **AI**: OpenAI Responses API (Batch)

## プロジェクト構成

### 📂 バックエンド: `worker/`
- **`worker/src/index.ts`**: APIサーバーのメインロジック。ルーティング、OpenAIプロキシ、Durable Object (`BatchStore`) の実装を含みます。
- **`syncBatchStatus` 関数**: アプリケーションの核心部分。OpenAI上のバッチステータスを確認し、完了していれば結果ファイルをダウンロードしてDBを更新します。
- **`wrangler.toml`**: Cloudflare Workers の構成ファイル。フロントエンドのビルドもここからトリガーされます。

### 💻 フロントエンド: `src/`
- **`src/App.tsx`**: 単一ページのコンソールUI。プロンプト管理、CSVインポート、バッチ実行トリガー、結果表示を行います。
- `POST /api/batch/sync` を通じてバックエンドと同期し、常に最新の状態を保ちます。

## デプロイ方法

1. **依存関係のインストール**:
   ```bash
   npm install
   ```

2. **環境変数の設定**:
   Cloudflare Workers に OpenAI API Key を設定します。
   ```bash
   cd worker
   npx wrangler secret put OPENAI_API_KEY
   ```

3. **デプロイ**:
   Wrangler を使用してデプロイします。自動的にフロントエンドもビルドされます。
   ```bash
   npx wrangler deploy
   ```

## ライセンス
MIT License
