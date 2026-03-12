import http from "http";
import { createClient } from "@supabase/supabase-js";

const PORT = Number(process.env.PORT || 8080);

const SUPABASE_URL = "https://fkcnhgdzpqbbcudoyjhn.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrY25oZ2R6cHFiYmN1ZG95amhuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjA1NzUwMCwiZXhwIjoyMDg3NjMzNTAwfQ.slS-vZkGoCpWoncM9r7etTfqJ5e5sTi2WkkQhoYRg3Q";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SERVER_URI = "https://shelly-165-eu.shelly.cloud";
const AUTH_KEY = "MmVkMWVidWlk2CAB39DBD5697035A61BC935AA12DF1D78A1196C36B19FB1B6AA4B8FB72062AB450CE001DBB77341";

const START_W = Number(process.env.START_THRESHOLD ?? 5);
const STOP_W = Number(process.env.STOP_THRESHOLD ?? 3);

const MAX_RETRIES_429 = Number(process.env.SHELLY_MAX_RETRIES_429 ?? 3);
const BACKOFF_BASE_MS = Number(process.env.SHELLY_BACKOFF_BASE_MS ?? 800);

const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 10000);
const ACTIVE_FROM = Number(process.env.ACTIVE_FROM ?? 8);
const ACTIVE_TO = Number(process.env.ACTIVE_TO ?? 24);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 15000);

const TAG_TO_DBID = {
  f1b457: "F1",
  f1b3d3: "F2",
  "7c87cebaa2ca": "F3",
  "7c87ceb512a6": "F4",
  "7c87ceb4811e": "F5",
};

let lastResponse = null;
let running = false;
let scanCount = 0;

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitErrorMessage(msg) {
  return typeof msg === "string" && msg.includes("429");
}

function inActiveWindow() {
  const h = new Date().getHours();
  return h >= ACTIVE_FROM && h < ACTIVE_TO;
}

function getShellyTagsFromEnv() {
  return ("f1b457,f1b3d3,7c87cebaa2ca,7c87ceb512a6,7c87ceb4811e" || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractPowerW(data) {
  const ds = data?.data?.device_status ?? data?.device_status ?? data;

  const a = ds?.meters?.[0]?.power;
  if (Number.isFinite(a)) return Number(a);

  const b = ds?.emeters?.[0]?.power;
  if (Number.isFinite(b)) return Number(b);

  const c = ds?.switches?.[0]?.power;
  if (Number.isFinite(c)) return Number(c);

  return null;
}

async function fetchDeviceStatus(shellyTag) {
  if (!SERVER_URI) throw new Error("Missing SHELLY_SERVER_URI");
  if (!AUTH_KEY) throw new Error("Missing SHELLY_AUTH_KEY");
  if (!shellyTag) throw new Error("Missing shellyTag");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${SERVER_URI}/device/status`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: shellyTag,
        auth_key: AUTH_KEY,
      }),
    });

    const text = await res.text();

    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Réponse non JSON: ${text}`);
    }

    if (!res.ok) {
      throw new Error(`device/status ${res.status}: ${JSON.stringify(data)}`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDeviceStatusWithRetry(shellyTag) {
  let attempt = 0;

  while (true) {
    try {
      return await fetchDeviceStatus(shellyTag);
    } catch (e) {
      const msg = e?.message || String(e);

      if (isRateLimitErrorMessage(msg) && attempt < MAX_RETRIES_429) {
        const backoff =
          BACKOFF_BASE_MS * Math.pow(2, attempt) +
          Math.floor(Math.random() * 250);

        console.log(
          `[${TAG_TO_DBID[shellyTag] || shellyTag}] 429 -> attente ${backoff} ms (retry ${attempt + 1}/${MAX_RETRIES_429})`
        );

        await sleep(backoff);
        attempt += 1;
        continue;
      }

      throw e;
    }
  }
}

async function getState(device_id) {
  const { data, error } = await supabase
    .from("device_state")
    .select("*")
    .eq("device_id", device_id)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return (
    data || {
      device_id,
      active: false,
      pending_start_ms: null,
      pending_stop_ms: null,
      open_start_ms: null,
    }
  );
}

async function saveState(st) {
  const { error } = await supabase.from("device_state").upsert(
    {
      device_id: st.device_id,
      active: st.active,
      pending_start_ms: st.pending_start_ms,
      pending_stop_ms: st.pending_stop_ms,
      open_start_ms: st.open_start_ms,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "device_id" }
  );

  if (error) throw new Error(error.message);
}

async function insertSessionStart(device_id, start_ms, start_w) {
  const { error } = await supabase.from("sessions").insert({
    device_id,
    start_ms,
    start_w,
  });

  if (error) throw new Error(error.message);
}

async function updateSessionStop(device_id, start_ms, end_ms, end_w) {
  const duration_sec = Math.max(0, Math.round((end_ms - start_ms) / 1000));

  const { data, error } = await supabase
    .from("sessions")
    .update({
      end_ms,
      end_w,
      duration_sec,
    })
    .eq("device_id", device_id)
    .eq("start_ms", start_ms)
    .is("end_ms", null)
    .select("device_id,start_ms,end_ms");

  if (error) throw new Error(error.message);

  return data?.length ?? 0;
}

async function pollOneDevice(shellyTag) {
  const ts = nowMs();
  const device_id = TAG_TO_DBID[shellyTag] || shellyTag;

  const status = await fetchDeviceStatusWithRetry(shellyTag);
  const power = extractPowerW(status);

  if (!Number.isFinite(power)) {
    return {
      ok: false,
      ts,
      shellyTag,
      device_id,
      error: "POWER_NOT_FOUND",
    };
  }

  const st = await getState(device_id);

  if (!st.active && power > START_W) {
    st.active = true;
    st.open_start_ms = ts;
    st.pending_start_ms = null;
    st.pending_stop_ms = null;

    await insertSessionStart(device_id, st.open_start_ms, power);
  } else if (st.active && power < STOP_W) {
    const startMs = st.open_start_ms;

    st.active = false;
    st.open_start_ms = null;
    st.pending_start_ms = null;
    st.pending_stop_ms = null;

    if (startMs) {
      await updateSessionStop(device_id, startMs, ts, power);
    }
  }

  await saveState(st);

  return {
    ok: true,
    ts,
    shellyTag,
    device_id,
    power,
    active: st.active,
  };
}

async function tick() {
  if (running) {
    return (
      lastResponse || {
        ok: false,
        count: 0,
        results: [],
        error: "SCAN_ALREADY_RUNNING",
      }
    );
  }

  running = true;
  scanCount += 1;

  console.log("--------------------------------------------------");
  console.log(`⏱ Scan #${scanCount} :`, new Date().toLocaleString());

  try {
    if (!SERVER_URI || !AUTH_KEY) {
      const response = {
        ok: false,
        error: "Missing env vars (SHELLY_SERVER_URI / SHELLY_AUTH_KEY)",
        count: 0,
        results: [],
      };

      lastResponse = response;
      console.log("JSON parsé :", JSON.stringify(response, null, 2));
      return response;
    }

    const shellyTags = getShellyTagsFromEnv();

    if (!shellyTags.length) {
      const response = {
        ok: false,
        error: "Missing SHELLY_DEVICE_IDS",
        count: 0,
        results: [],
      };

      lastResponse = response;
      console.log("JSON parsé :", JSON.stringify(response, null, 2));
      return response;
    }

    const results = [];

    for (const tag of shellyTags) {
      try {
        const r = await pollOneDevice(tag);
        results.push(r);
      } catch (e) {
        results.push({
          ok: false,
          ts: nowMs(),
          shellyTag: tag,
          device_id: TAG_TO_DBID[tag] || tag,
          error: e?.message || String(e),
        });
      }
    }

    const response = {
      ok: results.every((r) => r.ok),
      count: results.length,
      results,
    };

    lastResponse = response;
    console.log("JSON parsé :", JSON.stringify(response, null, 2));

    return response;
  } finally {
    running = false;
  }
}

async function main() {
  console.log("Poller démarré...");
  console.log("PORT =", PORT);
  console.log("INTERVAL_MS =", INTERVAL_MS);
  console.log("ACTIVE_FROM =", ACTIVE_FROM);
  console.log("ACTIVE_TO =", ACTIVE_TO);
  console.log("MAX_RETRIES_429 =", MAX_RETRIES_429);
  console.log("BACKOFF_BASE_MS =", BACKOFF_BASE_MS);
  console.log("FETCH_TIMEOUT_MS =", FETCH_TIMEOUT_MS);

  while (true) {
    try {
      if (!inActiveWindow()) {
        console.log("⏸ Hors plage horaire...");
        await sleep(60000);
        continue;
      }

      await tick();
      await sleep(INTERVAL_MS);
    } catch (e) {
      console.log("Erreur -> retry dans 3s :", e?.message || String(e));
      await sleep(3000);
    }
  }
}

http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
      return;
    }

    if (req.url === "/last") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(
        JSON.stringify(
          lastResponse || {
            ok: true,
            count: 0,
            results: [],
            message: "Aucun scan encore effectué",
          },
          null,
          2
        )
      );
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Poller running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log("Server HTTP :", PORT);
  });

main();
