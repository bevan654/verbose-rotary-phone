// Vercel Serverless Function: proxies chat-completion requests to DeepSeek.
// The API key lives ONLY here, as the DEEPSEEK_API_KEY environment variable —
// it is never sent to the browser, so it stays private even on a public site.
//
// The browser is untrusted, so this function sanitises and clamps every request
// before forwarding, bounding the cost of any single call no matter what the
// client sends.

const ALLOWED_MODEL = 'deepseek-chat';   // never let the client pick a pricier model
const MAX_OUTPUT_TOKENS = 4096;          // cap completion size per call
const MAX_MESSAGES = 8;                  // a chat request needs only a couple of messages
const MAX_PROMPT_CHARS = 20000;          // total characters across all message contents

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) {
        res.status(500).json({ error: 'Server is missing DEEPSEEK_API_KEY. Set it in the Vercel project settings.' });
        return;
    }

    // Shared passcode gate: if APP_PASSCODE is set, every request must present it.
    // This stops strangers who find the public URL from spending your credit.
    const requiredPasscode = process.env.APP_PASSCODE;
    if (requiredPasscode) {
        const provided = req.headers['x-app-passcode'] || '';
        if (provided !== requiredPasscode) {
            res.status(401).json({ error: 'Invalid or missing passcode.' });
            return;
        }
    }

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
        res.status(400).json({ error: 'Invalid JSON body.' });
        return;
    }

    // Lightweight passcode check for the page gate: the passcode was already validated
    // above, so just confirm — no DeepSeek call, no cost.
    if (body && body.check === true) {
        res.status(200).json({ ok: true });
        return;
    }

    // ---- Validate / clamp the request (do not trust the client) ----
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0 || messages.length > MAX_MESSAGES) {
        res.status(400).json({ error: `messages must contain 1 to ${MAX_MESSAGES} items.` });
        return;
    }
    const totalChars = messages.reduce((n, m) => n + (m && typeof m.content === 'string' ? m.content.length : 0), 0);
    if (totalChars > MAX_PROMPT_CHARS) {
        res.status(413).json({ error: `Prompt too large (limit ${MAX_PROMPT_CHARS} characters).` });
        return;
    }

    const safeBody = {
        model: ALLOWED_MODEL,
        messages,
        temperature: typeof body.temperature === 'number' ? Math.min(Math.max(body.temperature, 0), 1.5) : 0.5,
        max_tokens: Math.min(typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 1024, MAX_OUTPUT_TOKENS)
    };

    const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';

    try {
        const upstream = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify(safeBody)
        });

        const data = await upstream.json();
        res.status(upstream.status).json(data);
    } catch (err) {
        console.error('Proxy error:', err);
        res.status(502).json({ error: 'Upstream request failed.' });
    }
}
