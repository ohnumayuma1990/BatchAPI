import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types'
import type { Fetcher } from '@cloudflare/workers-types'

/**
 * Cloudflare Worker for OpenAI Responses API Batch processing.
 *
 * Endpoints:
 * - POST /api/batch/run
 *   body: { prompts: { id: string; prompt: string }[] }
 *   action: JSONL生成 → filesアップロード → batches作成 → { batchId }
 *
 * - GET /api/batch/status?batchId=...
 *   action: batches/{id} を返却（必要なら output_file_id を参照）
 *
 * - GET /api/batch/result?fileId=...
 *   action: files/{fileId}/content を返却（JSONLを text としてそのまま返す）
 *
 * 環境変数:
 * - OPENAI_API_KEY (required)
 * - OPENAI_BASE_URL (optional, default: https://api.openai.com/v1)
 */
export interface Env {
  OPENAI_API_KEY: string
  OPENAI_BASE_URL?: string
  ASSETS: Fetcher // wrangler.toml の [assets] binding
  BATCH_STORE: DurableObjectNamespace
}

type RunRequest = {
  prompts: { id: string; prompt: string }[]
  model?: string
  max_tokens?: number
  temperature?: number
}

const defaultModel = 'gpt-4o-mini' // 必要に応じて変更

type StoredPromptRow = {
  id: string
  prompt: string
  status: 'not_submitted' | 'queued' | 'running' | 'completed' | 'failed'
  batchId?: string
  result?: string
  error?: string
}

export default {
  // 型の衝突を避けるため any 扱いにしておく（実際には Cloudflare Worker の Request/Response）
  async fetch(request: any, env: Env): Promise<any> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'POST' && path === '/api/batch/run') {
      return runBatch(request, env)
    }
    if (request.method === 'GET' && path === '/api/batch/status') {
      const batchId = url.searchParams.get('batchId')
      if (!batchId) return new Response('batchId is required', { status: 400 })
      return getBatchStatus(batchId, env)
    }
    if (request.method === 'GET' && path === '/api/batch/result') {
      const fileId = url.searchParams.get('fileId')
      if (!fileId) return new Response('fileId is required', { status: 400 })
      return getBatchResult(fileId, env)
    }

    if (request.method === 'GET' && path === '/api/batch/list') {
      return getBatchList(env)
    }

    if (request.method === 'POST' && path === '/api/prompts/add') {
      return addPrompts(request, env)
    }

    if (request.method === 'POST' && path === '/api/batches/remove') {
      return deleteBatches(request, env)
    }

    // それ以外は静的アセットへフォールバック（Vite build の dist を配信）
    return (env.ASSETS as any).fetch(request)
  },
}

// Durable Object: バッチ実行したプロンプト一覧を永続化する
export class BatchStore {
  constructor(private state: DurableObjectState) {}

  async fetch(request: any): Promise<any> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname.endsWith('/prompts/add')) {
      const body = (await request.json()) as {
        prompts: { id: string; prompt: string }[]
      }
      const current =
        ((await this.state.storage.get<StoredPromptRow[]>('rows')) as
          | StoredPromptRow[]
          | undefined) ?? []

      const withoutDup = current.filter(
        (row) => !body.prompts.some((p) => p.id === row.id),
      )
      const appended: StoredPromptRow[] = body.prompts.map((p) => ({
        id: p.id,
        prompt: p.prompt,
        status: 'not_submitted',
      }))

      const next = [...withoutDup, ...appended]
      await this.state.storage.put('rows', next)
      return new Response(null, { status: 204 })
    }

    if (request.method === 'POST' && url.pathname.endsWith('/batches/register')) {
      const body = (await request.json()) as {
        batchId: string
        prompts: { id: string; prompt: string }[]
      }
      const current =
        ((await this.state.storage.get<StoredPromptRow[]>('rows')) as StoredPromptRow[] | undefined) ??
        []

      const withoutDup = current.filter(
        (row) => !body.prompts.some((p) => p.id === row.id),
      )
      const appended: StoredPromptRow[] = body.prompts.map((p) => ({
        id: p.id,
        prompt: p.prompt,
        status: 'queued',
        batchId: body.batchId,
      }))

      const next = [...withoutDup, ...appended]
      await this.state.storage.put('rows', next)
      return new Response(null, { status: 204 })
    }

    if (request.method === 'GET' && url.pathname.endsWith('/batches/list')) {
      const rows =
        ((await this.state.storage.get<StoredPromptRow[]>('rows')) as StoredPromptRow[] | undefined) ??
        []
      return jsonResponse({ rows })
    }

    return new Response('not found', { status: 404 })
  }
}

async function runBatch(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as RunRequest
  if (!body?.prompts?.length) {
    return new Response('prompts is required', { status: 400 })
  }

  const model = body.model ?? defaultModel
  const baseUrl = env.OPENAI_BASE_URL?.replace(/\/$/, '') ?? 'https://api.openai.com/v1'

  // 1) JSONL を組み立て
  const lines = body.prompts.map((p) =>
    JSON.stringify({
      custom_id: p.id,
      method: 'POST',
      url: '/v1/responses',
      body: {
        model,
        input: p.prompt,
        // 必要に応じて他のパラメータを追加
      },
    }),
  )
  const jsonl = lines.join('\n')

  // 2) files へアップロード
  const formData = new FormData()
  formData.append('purpose', 'batch')
  formData.append('file', new File([jsonl], 'batch.jsonl', { type: 'application/jsonl' }))

  const uploadResp = await fetch(`${baseUrl}/files`, {
    method: 'POST',
    headers: authHeader(env),
    body: formData,
  })
  if (!uploadResp.ok) {
    const err = await uploadResp.text()
    return new Response(`upload failed: ${err}`, { status: uploadResp.status })
  }
  const uploadJson = (await uploadResp.json()) as { id: string }
  const fileId = uploadJson.id

  // 3) batches を作成
  const batchResp = await fetch(`${baseUrl}/batches`, {
    method: 'POST',
    headers: {
      ...authHeader(env),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input_file_id: fileId,
      endpoint: '/v1/responses',
      completion_window: '24h',
    }),
  })
  if (!batchResp.ok) {
    const err = await batchResp.text()
    return new Response(`batch create failed: ${err}`, { status: batchResp.status })
  }
  const batchJson = await batchResp.json()

  // Durable Object にもメタ情報を保存（バッチ一覧用）
  try {
    const id = env.BATCH_STORE.idFromName('global')
    const stub = env.BATCH_STORE.get(id)
    await stub.fetch('https://batch-store/batches/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: batchJson.id,
        prompts: body.prompts,
      }),
    })
  } catch (e) {
    // ストレージ失敗は致命的ではないのでログだけ
    console.error('BatchStore register error', e)
  }

  return jsonResponse({ batchId: batchJson.id, inputFileId: fileId })
}

async function getBatchStatus(batchId: string, env: Env): Promise<Response> {
  const baseUrl = env.OPENAI_BASE_URL?.replace(/\/$/, '') ?? 'https://api.openai.com/v1'
  const resp = await fetch(`${baseUrl}/batches/${batchId}`, {
    method: 'GET',
    headers: authHeader(env),
  })
  if (!resp.ok) {
    const err = await resp.text()
    return new Response(`batch status failed: ${err}`, { status: resp.status })
  }
  const json = await resp.json()
  return jsonResponse(json)
}

async function getBatchResult(fileId: string, env: Env): Promise<Response> {
  const baseUrl = env.OPENAI_BASE_URL?.replace(/\/$/, '') ?? 'https://api.openai.com/v1'
  const resp = await fetch(`${baseUrl}/files/${fileId}/content`, {
    method: 'GET',
    headers: authHeader(env),
  })
  if (!resp.ok) {
    const err = await resp.text()
    return new Response(`batch result failed: ${err}`, { status: resp.status })
  }
  // OpenAI は JSONL を text として返すので、そのまま返却
  const text = await resp.text()
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

async function getBatchList(env: Env): Promise<any> {
  const id = env.BATCH_STORE.idFromName('global')
  const stub = env.BATCH_STORE.get(id)
  const resp = await stub.fetch('https://batch-store/batches/list')
  // DO からのレスポンスを素通し
  return resp as any
}

async function addPrompts(request: Request, env: Env): Promise<any> {
  const id = env.BATCH_STORE.idFromName('global')
  const stub = env.BATCH_STORE.get(id)
  const body = await request.text()
  const resp = await stub.fetch('https://batch-store/prompts/add', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  })
  return resp as any
}

async function deleteBatches(request: Request, env: Env): Promise<Response> {
  const id = env.BATCH_STORE.idFromName('global')
  const stub = env.BATCH_STORE.get(id)
  const body = await request.text() //もしくはjson()にしてbodyをパース
  const json = await request.json()

  const resp = await stub.fetch('https://batch-store/batches/remove', {
    method: 'POST',
    body: JSON.stringify({ ids: json.ids }), // 例：{ ids: ['id1', ...] }
    headers: { 'Content-Type': 'application/json' },
  })
  return resp as any
}

function authHeader(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

