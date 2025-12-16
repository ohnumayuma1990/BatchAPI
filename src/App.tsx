import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import Papa from 'papaparse'
import './App.css'

type BatchStatus = 'not_submitted' | 'queued' | 'running' | 'completed' | 'failed'

type PromptRow = {
  id: string
  prompt: string
  status: BatchStatus
  batchId?: string
  result?: string
  error?: string
}


const useFakeApi = import.meta.env.VITE_USE_FAKE_API === 'true'

// Cloudflare Worker 経由の本番 API クライアント
const workerApi = {
  async runBatchForPending(prompts: PromptRow[]): Promise<{ batchId: string; items: PromptRow[] }> {
    const res = await fetch('/api/batch/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompts: prompts.map((p) => ({ id: p.id, prompt: p.prompt })),
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Batch run failed: ${err}`)
    }
    const data = (await res.json()) as { batchId: string }
    // 実際の処理は非同期なので、まずは queued にして batchId を紐付け
    return {
      batchId: data.batchId,
      items: prompts.map((p) => ({
        ...p,
        status: 'queued' as BatchStatus,
        batchId: data.batchId,
      })),
    }
  },
}

// デモ用の擬似 API（フロント単体で動かす場合に使用）
const fakeApi = {
  async runBatchForPending(prompts: PromptRow[]): Promise<{ batchId: string; items: PromptRow[] }> {
    const batchId = `batch_${Date.now()}`
    const updated = prompts.map((p) => ({
      ...p,
      status: 'running' as BatchStatus,
      batchId,
    }))
    await new Promise((resolve) => setTimeout(resolve, 800))
    const completed = updated.map((p) => ({
      ...p,
      status: 'completed' as BatchStatus,
      result: `結果: ${p.prompt.slice(0, 40)}...`,
    }))
    return { batchId, items: completed }
  },
}

const api = useFakeApi ? fakeApi : workerApi

function App() {
  const [rows, setRows] = useState<PromptRow[]>([])
  const [newPrompt, setNewPrompt] = useState('')
  const [isBatchRunning, setIsBatchRunning] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const hasPending = useMemo(
    () => rows.some((r) => r.status === 'not_submitted' || r.status === 'failed'),
    [rows],
  )

  const hasSelection = selectedIds.length > 0
  const allSelected = rows.length > 0 && selectedIds.length === rows.length

  // Worker + Durable Object を使う場合は、起動時にサーバ側の一覧を読み込む
  useEffect(() => {
    if (useFakeApi) return
    

    ;(async () => {
      try {
        const res = await fetch('/api/batch/list')
        if (!res.ok) return
        const data = (await res.json()) as { rows?: PromptRow[] }
        if (Array.isArray(data.rows)) {
          setRows(data.rows)
        }
      } catch (e) {
        console.error(e)
      }
    })()
  }, [])

  const handleAddPrompt = () => {
    const text = newPrompt.trim()
    if (!text) return

    setRows((prev) => {
      const id = `${Date.now()}_${prev.length}`
      const nextRow: PromptRow = {
        id,
        prompt: text,
        status: 'not_submitted',
      }

      if (!useFakeApi) {
        // バックエンド（DO）にも登録
        void fetch('/api/prompts/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompts: [{ id, prompt: text }] }),
        }).catch((e) => console.error(e))
      }

      return [...prev, nextRow]
    })
    setNewPrompt('')
  }

  const handleUploadCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setIsUploading(true)
    try {
      const text = await file.text()
      const parsed = Papa.parse<string[]>(text, {
        skipEmptyLines: 'greedy',
      })

      if (parsed.errors.length) {
        console.error(parsed.errors)
      }

      const prompts = parsed.data
        .map((row) => (Array.isArray(row) ? row : []))
        .map((cols) => cols.join(',').trim())
        .filter((p) => p.length > 0)

      if (prompts.length === 0) return

      setRows((prev) => {
        const baseTime = Date.now()
        const appended: PromptRow[] = prompts.map((prompt, index) => ({
          id: `${baseTime}_${prev.length + index}`,
          prompt,
          status: 'not_submitted' as BatchStatus,
        }))

        if (!useFakeApi && appended.length > 0) {
          void fetch('/api/prompts/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompts: appended.map((p) => ({ id: p.id, prompt: p.prompt })),
            }),
          }).catch((e) => console.error(e))
        }

        return [...prev, ...appended]
      })
    } catch (error) {
      console.error(error)
    } finally {
      setIsUploading(false)
      // 同じファイルを再度選択できるようにリセット
      event.target.value = ''
    }
  }

  const handleRunBatch = async () => {
    if (!hasPending || isBatchRunning) return
    setIsBatchRunning(true)
    try {
      const pending = rows.filter((r) => r.status === 'not_submitted' || r.status === 'failed')
      const { items } = await api.runBatchForPending(pending)

      setRows((prev) =>
        prev.map((row) => items.find((i) => i.id === row.id) ?? row),
      )
    } catch (e) {
      console.error(e)
    } finally {
      setIsBatchRunning(false)
    }
  }

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds([])
    } else {
      setSelectedIds(rows.map((r) => r.id))
    }
  }

  const handleDeleteSelected = async () => {
    if (!hasSelection) return
    setRows((prev) => prev.filter((r) => !selectedIds.includes(r.id)))
    setSelectedIds([])

    // DOのデータも削除
    try {
      await fetch('/api/batches/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      })
    } catch (e) {
      console.error('Failed to delete from Durable Object:', e)
    }
  }

  // 追加：一覧取得用の関数
  const fetchBatchList = async () => {
    setIsLoading(true)

    try {
      const res = await fetch('/api/batch/status');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.rows)) {
        setRows(data.rows);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Cloudflare Batch Prompt Console</h1>
          <p className="page-subtitle">
            OpenAI Responses API の Batch を前提とした、プロンプト管理 UI のサンプルです。
          </p>
        </div>
      </header>

      <main className="page-main">
        <section className="card input-card">
          <h2>プロンプト登録</h2>
          {/* 更新ボタン追加 */}
          <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button className="btn outline" onClick={fetchBatchList} disabled={isLoading}>更新</button>
            {isLoading && <span>読み込み中...</span>}
          </div>
          <p className="section-description">
            実行したいプロンプトを入力し、「追加」でテーブルに登録します。
          </p>
          <div className="input-row">
            <textarea
              className="prompt-input"
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              placeholder="例）この文章を要約してください..."
              rows={3}
            />
          </div>
          <div className="input-actions">
            <button
              className="btn primary"
              onClick={handleAddPrompt}
              disabled={!newPrompt.trim()}
            >
              プロンプトを追加
            </button>
          </div>

          <div className="csv-upload">
            <label className="csv-label">
              CSV アップロード（1 行 1 プロンプト）
              <input
                type="file"
                accept=".csv,text/csv,.txt,text/plain"
                onChange={handleUploadCsv}
                disabled={isUploading}
              />
            </label>
            <p className="csv-help">
              UTF-8 の CSV / テキストファイルを想定しています。行区切りまたはダブルクオートで囲った複数行のセルを 1 件として追加します。
            </p>
          </div>
        </section>

        <section className="card table-card">
          <div className="table-header-row">
            <div>
              <h2>プロンプト一覧</h2>
              <p className="section-description">
                BatchStatus と実行結果を確認できます。未実行の行をまとめて Batch 実行します。
              </p>
            </div>
            <div className="table-actions">
              <button
                className="btn outline"
                onClick={handleRunBatch}
                disabled={!hasPending || isBatchRunning || rows.length === 0}
              >
                {isBatchRunning ? 'Batch 実行中...' : '未実行プロンプトを Batch 実行'}
              </button>
              <button
                className="btn danger"
                onClick={handleDeleteSelected}
                disabled={!hasSelection}
              >
                選択削除
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="empty-text">まだプロンプトが登録されていません。</p>
          ) : (
            <div className="table-wrapper">
              <table className="prompt-table">
                <thead>
                  <tr>
                    <th className="select-col">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        aria-label="全選択"
                      />
                    </th>
                    <th style={{ width: '120px' }}>ID</th>
                    <th>プロンプト</th>
                    <th style={{ width: '140px' }}>BatchStatus</th>
                    <th style={{ width: '200px' }}>Batch ID</th>
                    <th>実行結果</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="select-col">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(row.id)}
                          onChange={() => toggleSelectRow(row.id)}
                          aria-label="行選択"
                        />
                      </td>
                      <td className="mono">{row.id}</td>
                      <td className="prompt-cell">
                        <div className="prompt-text">{row.prompt}</div>
                      </td>
                      <td>
                        <span className={`status-pill status-${row.status}`}>
                          {row.status === 'not_submitted' && '未実行'}
                          {row.status === 'queued' && 'キュー待ち'}
                          {row.status === 'running' && '実行中'}
                          {row.status === 'completed' && '完了'}
                          {row.status === 'failed' && '失敗'}
                        </span>
                      </td>
                      <td className="mono">{row.batchId ?? '-'}</td>
                      <td>
                        {row.result ? (
                          <details>
                            <summary>結果を表示</summary>
                            <pre className="result-text">{row.result}</pre>
                          </details>
                        ) : row.error ? (
                          <span className="error-text">{row.error}</span>
                        ) : (
                          <span className="muted">未取得</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
