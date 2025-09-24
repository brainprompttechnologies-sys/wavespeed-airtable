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
});