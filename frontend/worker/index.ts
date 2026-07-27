export interface Env {
  TOPICS_KV: KVNamespace;
  GITHUB_TOKEN: string;
}

const WORKER_TOPICS_URL = "https://raw.githubusercontent.com/yinbing-666/hermes-office-mobile/master/frontend/public/topics.json";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ ok: true, ts: Date.now() });
    }

    // Topics endpoint
    if (url.pathname === "/api/topics" || url.pathname === "/topics.json") {
      try {
        // Try KV cache first
        const cached = await env.TOPICS_KV.get("topics", "json") as any;
        if (cached) {
          const headers = {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
          };
          return new Response(JSON.stringify(cached), { headers });
        }

        // Fallback: fetch from GitHub raw
        const token = env.GITHUB_TOKEN || "";
        const headers: Record<string, string> = {
          "Accept": "application/json",
          "Access-Control-Allow-Origin": "*",
        };
        if (token) headers["Authorization"] = `token ${token}`;

        const resp = await fetch(WORKER_TOPICS_URL, { headers });
        if (!resp.ok) throw new Error(`GitHub fetch failed: ${resp.status}`);

        const data = await resp.json();

        // Cache to KV (expire in 24h)
        await env.TOPICS_KV.put("topics", JSON.stringify(data), { expirationTtl: 86400 });

        const responseHeaders = {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
          "X-Source": "github",
        };
        return new Response(JSON.stringify(data), { headers: responseHeaders });
      } catch (err: any) {
        return Response.json(
          { ok: true, topics: [], source: "error", message: err.message },
          { status: 200, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }
    }

    // Proxy other /api/* to local BFF
    if (url.pathname.startsWith("/api/")) {
      const localUrl = `http://127.0.0.1:8787${url.pathname}${url.search}`;
      try {
        const resp = await fetch(localUrl, {
          headers: { "X-Forwarded-For": request.headers.get("CF-Connecting-IP") || "" },
        });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch {
        return Response.json({ error: "BFF unreachable" }, { status: 502 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
