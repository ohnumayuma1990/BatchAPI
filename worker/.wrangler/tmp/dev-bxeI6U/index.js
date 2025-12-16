var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var defaultModel = "gpt-4o-mini";
var src_default = {
  // 型の衝突を避けるため any 扱いにしておく（実際には Cloudflare Worker の Request/Response）
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "POST" && path === "/api/batch/run") {
      return runBatch(request, env);
    }
    if (request.method === "GET" && path === "/api/batch/status") {
      const batchId = url.searchParams.get("batchId");
      if (!batchId) return new Response("batchId is required", { status: 400 });
      return getBatchStatus(batchId, env);
    }
    if (request.method === "GET" && path === "/api/batch/result") {
      const fileId = url.searchParams.get("fileId");
      if (!fileId) return new Response("fileId is required", { status: 400 });
      return getBatchResult(fileId, env);
    }
    if (request.method === "POST" && path === "/api/batch/sync") {
      return syncBatchStatus(env);
    }
    if (request.method === "GET" && path === "/api/batch/list") {
      return getBatchList(env);
    }
    if (request.method === "POST" && path === "/api/prompts/add") {
      return addPrompts(request, env);
    }
    if (request.method === "POST" && path === "/api/batches/remove") {
      return deleteBatches(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
var BatchStore = class {
  constructor(state) {
    this.state = state;
  }
  static {
    __name(this, "BatchStore");
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/prompts/add")) {
      const body = await request.json();
      const current = await this.state.storage.get("rows") ?? [];
      const withoutDup = current.filter(
        (row) => !body.prompts.some((p) => p.id === row.id)
      );
      const appended = body.prompts.map((p) => ({
        id: p.id,
        prompt: p.prompt,
        status: "not_submitted"
      }));
      const next = [...withoutDup, ...appended];
      await this.state.storage.put("rows", next);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname.endsWith("/batches/register")) {
      const body = await request.json();
      const current = await this.state.storage.get("rows") ?? [];
      const withoutDup = current.filter(
        (row) => !body.prompts.some((p) => p.id === row.id)
      );
      const appended = body.prompts.map((p) => ({
        id: p.id,
        prompt: p.prompt,
        status: "queued",
        batchId: body.batchId
      }));
      const next = [...withoutDup, ...appended];
      await this.state.storage.put("rows", next);
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname.endsWith("/batches/list")) {
      const rows = await this.state.storage.get("rows") ?? [];
      return jsonResponse({ rows });
    }
    if (request.method === "POST" && url.pathname.endsWith("/batches/remove")) {
      const body = await request.json();
      const current = await this.state.storage.get("rows") ?? [];
      const next = current.filter((row) => !body.ids.includes(row.id));
      await this.state.storage.put("rows", next);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname.endsWith("/batches/update")) {
      const body = await request.json();
      const current = await this.state.storage.get("rows") ?? [];
      const next = current.map((row) => {
        const update = body.rows.find((u) => u.id === row.id);
        return update ? update : row;
      });
      await this.state.storage.put("rows", next);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }
};
async function runBatch(request, env) {
  const body = await request.json();
  if (!body?.prompts?.length) {
    return new Response("prompts is required", { status: 400 });
  }
  const model = body.model ?? defaultModel;
  const baseUrl = env.OPENAI_BASE_URL?.replace(/\/$/, "") ?? "https://api.openai.com/v1";
  const lines = body.prompts.map(
    (p) => JSON.stringify({
      custom_id: p.id,
      method: "POST",
      url: "/v1/responses",
      body: {
        model,
        input: p.prompt
        // 必要に応じて他のパラメータを追加
      }
    })
  );
  const jsonl = lines.join("\n");
  const formData = new FormData();
  formData.append("purpose", "batch");
  formData.append("file", new File([jsonl], "batch.jsonl", { type: "application/jsonl" }));
  const uploadResp = await fetch(`${baseUrl}/files`, {
    method: "POST",
    headers: authHeader(env),
    body: formData
  });
  if (!uploadResp.ok) {
    const err = await uploadResp.text();
    return new Response(`upload failed: ${err}`, { status: uploadResp.status });
  }
  const uploadJson = await uploadResp.json();
  const fileId = uploadJson.id;
  const batchResp = await fetch(`${baseUrl}/batches`, {
    method: "POST",
    headers: {
      ...authHeader(env),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input_file_id: fileId,
      endpoint: "/v1/responses",
      completion_window: "24h"
    })
  });
  if (!batchResp.ok) {
    const err = await batchResp.text();
    return new Response(`batch create failed: ${err}`, { status: batchResp.status });
  }
  const batchJson = await batchResp.json();
  try {
    const id = env.BATCH_STORE.idFromName("global");
    const stub = env.BATCH_STORE.get(id);
    await stub.fetch("https://batch-store/batches/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchId: batchJson.id,
        prompts: body.prompts
      })
    });
  } catch (e) {
    console.error("BatchStore register error", e);
  }
  return jsonResponse({ batchId: batchJson.id, inputFileId: fileId });
}
__name(runBatch, "runBatch");
async function getBatchStatus(batchId, env) {
  const baseUrl = env.OPENAI_BASE_URL?.replace(/\/$/, "") ?? "https://api.openai.com/v1";
  const resp = await fetch(`${baseUrl}/batches/${batchId}`, {
    method: "GET",
    headers: authHeader(env)
  });
  if (!resp.ok) {
    const err = await resp.text();
    return new Response(`batch status failed: ${err}`, { status: resp.status });
  }
  const json = await resp.json();
  return jsonResponse(json);
}
__name(getBatchStatus, "getBatchStatus");
async function getBatchResult(fileId, env) {
  const baseUrl = env.OPENAI_BASE_URL?.replace(/\/$/, "") ?? "https://api.openai.com/v1";
  const resp = await fetch(`${baseUrl}/files/${fileId}/content`, {
    method: "GET",
    headers: authHeader(env)
  });
  if (!resp.ok) {
    const err = await resp.text();
    return new Response(`batch result failed: ${err}`, { status: resp.status });
  }
  const text = await resp.text();
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
__name(getBatchResult, "getBatchResult");
async function getBatchList(env) {
  const id = env.BATCH_STORE.idFromName("global");
  const stub = env.BATCH_STORE.get(id);
  const resp = await stub.fetch("https://batch-store/batches/list");
  return resp;
}
__name(getBatchList, "getBatchList");
async function addPrompts(request, env) {
  const id = env.BATCH_STORE.idFromName("global");
  const stub = env.BATCH_STORE.get(id);
  const body = await request.text();
  const resp = await stub.fetch("https://batch-store/prompts/add", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" }
  });
  return resp;
}
__name(addPrompts, "addPrompts");
async function deleteBatches(request, env) {
  const id = env.BATCH_STORE.idFromName("global");
  const stub = env.BATCH_STORE.get(id);
  const json = await request.json();
  const resp = await stub.fetch("https://batch-store/batches/remove", {
    method: "POST",
    body: JSON.stringify({ ids: json.ids }),
    // 例：{ ids: ['id1', ...] }
    headers: { "Content-Type": "application/json" }
  });
  return resp;
}
__name(deleteBatches, "deleteBatches");
async function syncBatchStatus(env) {
  const id = env.BATCH_STORE.idFromName("global");
  const stub = env.BATCH_STORE.get(id);
  const listResp = await stub.fetch("https://batch-store/batches/list");
  if (!listResp.ok) return listResp;
  const { rows } = await listResp.json();
  const activeBatchIds = Array.from(new Set(
    rows.filter((r) => r.batchId && r.status !== "completed" && r.status !== "failed" && r.status !== "not_submitted").map((r) => r.batchId)
  ));
  const updates = [];
  const baseUrl = env.OPENAI_BASE_URL?.replace(/\/$/, "") ?? "https://api.openai.com/v1";
  for (const batchId of activeBatchIds) {
    try {
      const statusResp = await fetch(`${baseUrl}/batches/${batchId}`, {
        method: "GET",
        headers: authHeader(env)
      });
      if (!statusResp.ok) continue;
      const batchData = await statusResp.json();
      const openAiStatus = batchData.status;
      let newRowStatus;
      if (openAiStatus === "completed") {
        newRowStatus = "completed";
      } else if (openAiStatus === "failed" || openAiStatus === "expired" || openAiStatus === "cancelled") {
        newRowStatus = "failed";
      } else {
        newRowStatus = "running";
      }
      let resultMap = {};
      if (openAiStatus === "completed" && batchData.output_file_id) {
        const fileResp = await fetch(`${baseUrl}/files/${batchData.output_file_id}/content`, {
          method: "GET",
          headers: authHeader(env)
        });
        if (fileResp.ok) {
          const fileText = await fileResp.text();
          const lines = fileText.trim().split("\n");
          lines.forEach((line) => {
            try {
              const json = JSON.parse(line);
              if (json.custom_id) {
                const content = json.response?.body?.choices?.[0]?.message?.content ?? JSON.stringify(json.response);
                resultMap[json.custom_id] = content;
              }
            } catch (e) {
            }
          });
        }
      }
      rows.filter((r) => r.batchId === batchId).forEach((row) => {
        let updated = false;
        const clone = { ...row };
        if (newRowStatus && clone.status !== newRowStatus) {
          clone.status = newRowStatus;
          updated = true;
        }
        if (newRowStatus === "completed" && resultMap[row.id]) {
          clone.result = resultMap[row.id];
          updated = true;
        }
        if (newRowStatus === "failed" && !clone.error) {
          clone.error = `Batch status: ${openAiStatus}`;
          clone.result = void 0;
          updated = true;
        }
        if (updated) {
          updates.push(clone);
        }
      });
    } catch (e) {
      console.error(`Failed to sync batch ${batchId}`, e);
    }
  }
  if (updates.length > 0) {
    await stub.fetch("https://batch-store/batches/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: updates })
    });
    const updatedIds = updates.map((u) => u.id);
    const finalRows = rows.map((r) => {
      const u = updates.find((up) => up.id === r.id);
      return u ? u : r;
    });
    return jsonResponse({ rows: finalRows });
  }
  return jsonResponse({ rows });
}
__name(syncBatchStatus, "syncBatchStatus");
function authHeader(env) {
  return {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`
  };
}
__name(authHeader, "authHeader");
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
__name(jsonResponse, "jsonResponse");

// ../../../../Users/ohnum/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../Users/ohnum/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-eKfjHH/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../Users/ohnum/AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-eKfjHH/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  BatchStore,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
