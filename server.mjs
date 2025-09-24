import express from "express";
import fetch from "node-fetch";

// ====== ENV ======
const {
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE, // Use the TABLE ID (tbl...)
  AIRTABLE_TOKEN,
  WAVESPEED_API_KEY,
  PUBLIC_BASE_URL, // e.g. https://your-app.onrender.com
} = process.env;

if (!AIRTABLE_BASE_ID || !AIRTABLE_TABLE || !AIRTABLE_TOKEN) {
  console.error("Missing Airtable env vars.");
}
if (!WAVESPEED_API_KEY) console.error("Missing WAVESPEED_API_KEY");

const WAVESPEED_API_BASE = process.env.WAVESPEED_API_BASE || "https://api.wavespeed.ai"; // adjust if needed
const MODEL_NAME = process.env.WAVESPEED_MODEL || "Seedream v4"; // adjust if needed
const SUBMIT_SPACING_MS = parseInt(process.env.SUBMIT_SPACING_MS || "1200", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "10000", 10);
const POLL_TIMEOUT_MIN = parseInt(process.env.POLL_TIMEOUT_MIN || "15", 10); // per job timeout window

// ====== APP ======
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "10mb" }));

// ====== HELPERS ======
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function toDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch image failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "image/jpeg"; // best-effort mime sniff
  const b64 = buf.toString("base64");
  return `data:${ct};base64,${b64}`;
}

// ====== AIRTABLE HELPERS ======
const AT_BASE = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;
const atHeaders = {
  Authorization: `Bearer ${AIRTABLE_TOKEN}`,
  "Content-Type": "application/json",
};

async function atCreate(fields) {
  const body = { records: [{ fields }] };
  const res = await fetch(AT_BASE, { method: "POST", headers: atHeaders, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`Airtable create failed: ${res.status} ${JSON.stringify(json)}`);
  return json.records[0];
}

async function atUpdate(recordId, fields) {
  const body = { records: [{ id: recordId, fields }] };
  const res = await fetch(AT_BASE, { method: "PATCH", headers: atHeaders, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`Airtable update failed: ${res.status} ${JSON.stringify(json)}`);
  return json.records[0];
}

async function atGet(recordId) {
  const res = await fetch(`${AT_BASE}/${recordId}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`Airtable get failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function atListProcessing(limit = 50) {
  const params = new URLSearchParams({
    filterByFormula: "{Status}='processing'",
    maxRecords: String(limit),
  });
  const res = await fetch(`${AT_BASE}?${params.toString()}`, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`Airtable list failed: ${res.status} ${JSON.stringify(json)}`);
  return json.records || [];
}

// Utility to append to an Attachment field without losing existing items
function buildAttachmentMerge(existing = [], newUrls = []) {
  const keep = (existing || []).map((a) => ({ url: a.url }));
  const add = (newUrls || []).map((u) => ({ url: u }));
  return [...keep, ...add];
}

// ====== WAVESPEED ======
async function submitWaveSpeedJob({ prompt, imagesDataUrls, width, height, webhookUrl }) {
  const payload = {
    model: MODEL_NAME,
    prompt,
    images: imagesDataUrls, // subject first, refs after
    width: Number(width),
    height: Number(height),
    webhook_url: webhookUrl,
  };
  const res = await fetch(`${WAVESPEED_API_BASE}/v1/seedream/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WAVESPEED_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`WaveSpeed submit failed: ${res.status} ${JSON.stringify(json)}`);
  return json.job_id || json.id; // adjust if your API returns a different key
}

async function getWaveSpeedJob(jobId) {
  const res = await fetch(`${WAVESPEED_API_BASE}/v1/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`WaveSpeed job get failed: ${res.status} ${JSON.stringify(json)}`);
  return json; // expected: { status: 'queued|processing|succeeded|failed', outputs: [{url: "..."}] }
}

async function withRetries(fn, { tries = 4, baseDelay = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = baseDelay * 2 ** i + Math.floor(Math.random() * 250);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ====== ROUTES ======
app.get("/", (_req, res) => {
  res.type("text").send("OK");
});

app.get("/app", (_req, res) => {
  const envMsg = PUBLIC_BASE_URL ? "Webhook ready" : "Set PUBLIC_BASE_URL after first deploy";
  const html =
    '<html><head><title>WaveSpeed × Airtable</title></head>' +
    '<body style="font-family: system-ui; padding: 24px; max-width: 720px; margin: auto;">' +
    '<h1>Generate Batch</h1>' +
    '<form method="POST" action="/generate-batch">' +
    '<label>Prompt<br/><textarea name="prompt" rows="5" style="width:100%" required></textarea></label><br/><br/>' +
    '<label>Subject URL<br/><input name="subjectUrl" type="url" style="width:100%" required/></label><br/><br/>' +
    '<label>Reference URLs (comma separated)<br/><input name="refUrls" type="text" style="width:100%" placeholder="https://... , https://..."/></label><br/><br/>' +
    '<label>Width × Height<br/>' +
    '<input name="width" type="number" min="64" value="2227" required/> × ' +
    '<input name="height" type="number" min="64" value="3961" required/>' +
    '</label><br/><br/>' +
    '<label>Batch count<br/><input name="batch" type="number" min="1" max="12" value="4" required/></label><br/><br/>' +
    '<button type="submit">Generate</button>' +
    '</form>' +
    '<p style="margin-top:16px; color:#555;">Env: ' + envMsg + "</p>" +
    "</body></html>";
  res.type("html").send(html);
});

app.post("/generate-batch", async (req, res) => {
  try {
    const { prompt, subjectUrl, refUrls = "", width, height, batch } = req.body;
    const batchCount = Math.max(1, Math.min(Number(batch) || 1, 20));

    // Prepare images → subject first, then references
    const subjectDataUrl = await withRetries(() => toDataUrl(subjectUrl));
    const refs = (refUrls || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const refsData = [];
    for (const u of refs) {
      const d = await withRetries(() => toDataUrl(u));
      refsData.push(d);
    }

    const imagesDataUrls = [subjectDataUrl, ...refsData];

    // Create Airtable parent row
    const nowIso = new Date().toISOString();
    const parent = await atCreate({
      Prompt: prompt,
      Model: MODEL_NAME,
      Size: `${width}x${height}`,
      Status: "processing",
      "Created at": nowIso,
      "Last Update": nowIso,
    });

    const recordId = parent.id;
    const runId = recordId; // reuse record ID as run ID

    const baseUrl = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const webhookUrl = `${baseUrl}/webhooks/wavespeed`;

    const requestIds = [];
    for (let i = 0; i < batchCount; i++) {
      const jid = await withRetries(() => submitWaveSpeedJob({
        prompt,
        imagesDataUrls,
        width,
        height,
        webhookUrl,
      }));
      requestIds.push(jid);
      if (i < batchCount - 1) await sleep(SUBMIT_SPACING_MS);
    }

    await atUpdate(recordId, {
      "Run ID": runId,
      "Request IDs": JSON.stringify(requestIds),
      Subject: [{ url: subjectUrl }],
      References: refs.map((u) => ({ url: u })),
      "Last Update": new Date().toISOString(),
    });

    res.status(200).type("html").send(
      '<p>Batch started. Run ID: ' + runId + '</p><p><a href="/app">Back</a></p>'
    );
  } catch (e) {
    console.error("/generate-batch error", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// WaveSpeed webhook: expects JSON body with job id + outputs
app.post("/webhooks/wavespeed", async (req, res) => {
  try {
    const payload = req.body || {};
    const jobId = payload.job_id || payload.id || payload.jobId;
    const status = payload.status; // 'succeeded' | 'failed' | 'processing'
    const outputUrls = ((payload.outputs || [])).map((o) => o.url || o).filter(Boolean);

    // Find the parent record that contains this jobId in Request IDs
    const formula = encodeURIComponent(`AND({Status}='processing', FIND('\"${jobId}\"',{Request IDs}))`);
    const resList = await fetch(`${AT_BASE}?filterByFormula=${formula}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    const listJson = await resList.json();
    const rec = listJson.records && listJson.records[0];

    if (!rec) {
      console.warn("Webhook: parent record not found for job", jobId);
      return res.status(200).json({ ok: true });
    }

    const recordId = rec.id;
    const fields = rec.fields || {};

    // Merge outputs into Attachment field
    const mergedOutput = buildAttachmentMerge(fields.Output, outputUrls);

    // Track seen/failed ids
    const seen = new Set(((fields["Seen IDs"]) ? fields["Seen IDs"].split(",") : []).map((s) => s.trim()).filter(Boolean));
    const failed = new Set(((fields["Failed IDs"]) ? fields["Failed IDs"].split(",") : []).map((s) => s.trim()).filter(Boolean));
    if (status === "succeeded" && jobId) seen.add(jobId);
    if (status === "failed" && jobId) failed.add(jobId);

    await atUpdate(recordId, {
      Output: mergedOutput,
      "Seen IDs": Array.from(seen).join(","),
      "Failed IDs": Array.from(failed).join(","),
      "Last Update": new Date().toISOString(),
    });

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("/webhooks/wavespeed error", e);
    res.status(200).json({ ok: true }); // acknowledge to avoid repeated retries
  }
});

// ====== POLLER ======
async function finalizeIfDone(record) {
  const f = record.fields || {};
  const reqIds = (() => {
    try { return JSON.parse(f["Request IDs"] || "[]"); } catch { return []; }
  })();
  const seen = new Set((f["Seen IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
  const failed = new Set((f["Failed IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));

  const all = new Set([...seen, ...failed]);
  const remaining = reqIds.filter((id) => !all.has(id));

  if (remaining.length === 0) {
    await atUpdate(record.id, {
      Status: "completed",
      "Completed At": new Date().toISOString(),
      "Last Update": new Date().toISOString(),
    });
    return true;
  }
  return false;
}

async function pollOnce() {
  const processing = await atListProcessing(50);
  for (const rec of processing) {
    const f = rec.fields || {};
    const reqIds = (() => { try { return JSON.parse(f["Request IDs"] || "[]"); } catch { return []; } })();
    const startedAt = new Date(f["Created at"] || rec.createdTime || Date.now());
    const cutoff = new Date(startedAt.getTime() + POLL_TIMEOUT_MIN * 60 * 1000);

    const seen = new Set((f["Seen IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
    const failed = new Set((f["Failed IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));

    const pending = reqIds.filter((id) => !seen.has(id) && !failed.has(id));

    for (const id of pending) {
      try {
        const j = await withRetries(() => getWaveSpeedJob(id), { tries: 3, baseDelay: 600 });
        if (j.status === "succeeded") {
          const urls = (j.outputs || []).map((o) => o.url || o).filter(Boolean);
          const current = await atGet(rec.id);
          const mergedOutput = buildAttachmentMerge(current.fields.Output, urls);
          const newSeen = new Set((current.fields["Seen IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
          newSeen.add(id);
          await atUpdate(rec.id, {
            Output: mergedOutput,
            "Seen IDs": Array.from(newSeen).join(","),
            "Last Update": new Date().toISOString(),
          });
        } else if (j.status === "failed") {
          const current = await atGet(rec.id);
          const newFailed = new Set((current.fields["Failed IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
          newFailed.add(id);
          await atUpdate(rec.id, {
            "Failed IDs": Array.from(newFailed).join(","),
            "Last Update": new Date().toISOString(),
          });
        }
      } catch (e) {
        console.warn("poll job error", id, e.message);
      }
    }

    // Timeout finalize
    if (new Date() > cutoff) {
      const current = await atGet(rec.id);
      const f2 = current.fields || {};
      const reqIds2 = (() => { try { return JSON.parse(f2["Request IDs"] || "[]"); } catch { return []; } })();
      const seen2 = new Set((f2["Seen IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
      const failed2 = new Set((f2["Failed IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean));
      for (const id of reqIds2) {
        if (!seen2.has(id) && !failed2.has(id)) failed2.add(id);
      }
      await atUpdate(rec.id, {
        "Failed IDs": Array.from(failed2).join(","),
        "Last Update": new Date().toISOString(),
      });
    }

    await finalizeIfDone(rec);
  }
}

setInterval(() => {
  pollOnce().catch((e) => console.error("pollOnce error", e));
}, POLL_INTERVAL_MS);

// ====== START ======
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on :${port}`);
});
