# jozobozo.org

Personal site of Jozo Meštrović — static HTML/CSS, deployed on Cloudflare Pages.

## Stack
- Plain HTML + CSS
- [anime.js](https://animejs.com) for entrance animations

## Local preview
Open `index.html` in a browser, or serve the directory:

```bash
python -m http.server 8000
```

## Deploy (Cloudflare Pages)
1. Push to GitHub.
2. In Cloudflare → Pages → **Create a project** → **Connect to Git** → select this repo.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `/`
4. Add custom domain `jozobozo.org` under the project's **Custom domains** tab.

`_headers` and `_redirects` are picked up automatically by Pages.

## Jarviz — phone-hosted LLM chat

The "Jarviz" project on the homepage is a chat widget that talks to a tiny LLM running on my Android phone (Termux + llama.cpp + Cloudflare Tunnel, OpenAI-compatible API).

**Architecture:** browser → `/api/phone-llm/chat` (Cloudflare Pages Function) → Cloudflare Tunnel → llama-server on phone. The API key never reaches the browser.

### Configure environment variables

In the Cloudflare dashboard: **Pages → your project → Settings → Environment variables → Production** (and **Preview** if you want it on preview deploys), add:

| Variable | Example |
| --- | --- |
| `PHONE_LLM_BASE_URL` | `https://llm.jozobozo.org` |
| `PHONE_LLM_API_KEY` | *(secret — mark as **encrypted**)* |
| `PHONE_LLM_MODEL` | `llama-3.2-3b-instruct.q4km.gguf` |

Mark `PHONE_LLM_API_KEY` as **encrypted** so it's not readable from the dashboard after saving. Redeploy after changing values.

For local testing with `wrangler pages dev`, copy `.env.example` to `.dev.vars` and fill in the values:

```
PHONE_LLM_BASE_URL=https://llm.jozobozo.org
PHONE_LLM_API_KEY=...
PHONE_LLM_MODEL=llama-3.2-3b-instruct.q4km.gguf
```

Then run:

```bash
npx wrangler pages dev .
```

### What the proxy enforces

- Rate limit: 10 requests / minute / IP (per worker isolate, best-effort)
- Max user-message length: 1000 chars
- History window: last 8 messages
- `max_tokens`: 180, `temperature`: 0.4 (frontend cannot override)
- Upstream timeout: 30 s
- System prompt is injected server-side and cannot be replaced by the client
- Friendly error messages for offline / auth / timeout / unknown failures; details logged server-side only
