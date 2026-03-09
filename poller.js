import http from "http";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://fkcnhgdzpqbbcudoyjhn.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrY25oZ2R6cHFiYmN1ZG95amhuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjA1NzUwMCwiZXhwIjoyMDg3NjMzNTAwfQ.slS-vZkGoCpWoncM9r7etTfqJ5e5sTi2WkkQhoYRg3Q";
const SERVER_URI = "https://shelly-165-eu.shelly.cloud";
const AUTH_KEY = "MmVkMWVidWlk2CAB39DBD5697035A61BC935AA12DF1D78A1196C36B19FB1B6AA4B8FB72062AB450CE001DBB77341";

 

 
const PORT = 8080;
const INTERVAL_MS = 3000;
const FETCH_TIMEOUT_MS = 2500;

const START_W = 5;
const STOP_W = 2;

const SHELLY_DEVICE_IDS = [
  "f1b457",
  "f1b3d3",
  "7c87cebaa2ca",
  "7c87ceb512a6",
  "7c87ceb4811e",
];

const TAG_TO_DBID = {
  f1b457: "F1",
  f1b3d3: "F2",
  "7c87cebaa2ca": "F3",
  "7c87ceb512a6": "F4",
  "7c87ceb4811e": "F5",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// =========================
// UTILS
// =========================
function nowMs() {
  return Date.now();
}

async function fetchDeviceStatus(tag) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${SERVER_URI}/device/status`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: tag,
        auth_key: AUTH_KEY,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Timeout après ${FETCH_TIMEOUT_MS} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function extractPower(data) {
  const ds = data?.data?.device_status ?? data?.device_status ?? data;

  const a = ds?.meters?.[0]?.power;
  if (Number.isFinite(a)) return Number(a);

  const b = ds?.emeters?.[0]?.power;
  if (Number.isFinite(b)) return Number(b);

  const c = ds?.switches?.[0]?.power;
  if (Number.isFinite(c)) return Number(c);

  return null;
}

// =========================
// SUPABASE HELPERS
// =========================
async function getState(device_id) {
  const { data, error } = await supabase
    .from("device_state")
    .select("*")
    .eq("device_id", device_id)
    .maybeSingle();

  if (error) throw error;

  return (
    data || {
      device_id,
      active: false,
      open_start_ms: null,
    }
  );
}

async function saveState(st) {
  const { error } = await supabase.from("device_state").upsert(
    {
      device_id: st.device_id,
      active: st.active,
      open_start_ms: st.open_start_ms,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "device_id" }
  );

  if (error) throw error;
}

async function insertSessionStart(device_id, start_ms, start_w) {
  const { error } = await supabase.from("sessions").insert({
    device_id,
    start_ms,
    start_w,
  });

  if (error) throw error;
}

async function updateSessionStop(device_id, start_ms, end_ms, end_w) {
  const duration_sec = Math.round((end_ms - start_ms) / 1000);

  const { error } = await supabase
    .from("sessions")
    .update({
      end_ms,
      end_w,
      duration_sec,
    })
    .eq("device_id", device_id)
    .eq("start_ms", start_ms)
    .is("end_ms", null);

  if (error) throw error;
}

// =========================
// BUSINESS LOGIC
// =========================
async function pollOne(tag) {
  const ts = nowMs();
  const device_id = TAG_TO_DBID[tag] || tag;

  const status = await fetchDeviceStatus(tag);
  const power = extractPower(status);
  const st = await getState(device_id);

  if (power == null) {
    await saveState(st);
    return {
      ok: false,
      device_id,
      power: null,
      active: st.active,
      reason: "power introuvable",
    };
  }

  if (!st.active && power > START_W) {
    st.active = true;
    st.open_start_ms = ts;
    await insertSessionStart(device_id, ts, power);
  } else if (st.active && power < STOP_W) {
    const start = st.open_start_ms;

    st.active = false;
    st.open_start_ms = null;

    if (start) {
      await updateSessionStop(device_id, start, ts, power);
    }
  }

  await saveState(st);

  return {
    ok: true,
    device_id,
    power,
    active: st.active,
  };
}

let pollCount = 0;

async function tick() {
  pollCount++;
  const currentPoll = pollCount;
  const startedAt = Date.now();

  console.log("--------------------------------------------------");
  console.log(`[POLL ${currentPoll}] départ : ${new Date().toISOString()}`);

  try {
    const results = await Promise.allSettled(
      SHELLY_DEVICE_IDS.map((tag) => pollOne(tag))
    );

    for (let i = 0; i < results.length; i++) {
      const tag = SHELLY_DEVICE_IDS[i];
      const result = results[i];

      if (result.status === "fulfilled") {
        console.log(`[POLL ${currentPoll}] [OK ${tag}]`, result.value);
      } else {
        console.error(
          `[POLL ${currentPoll}] [ERR ${tag}]`,
          result.reason?.message || result.reason
        );
      }
    }
  } catch (err) {
    console.error(`[POLL ${currentPoll}] erreur globale :`, err.message);
  } finally {
    const elapsed = Date.now() - startedAt;
    console.log(`[POLL ${currentPoll}] fin : ${new Date().toISOString()}`);
    console.log(`[POLL ${currentPoll}] temps total : ${elapsed} ms`);
    console.log(
      `[POLL ${currentPoll}] mémoire RSS : ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB`
    );
  }
}

// =========================
// HTTP SERVER
// =========================
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Poller running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
  });

// =========================
// START
// =========================
console.log("Poller démarré");
console.log("Interval :", INTERVAL_MS, "ms");
console.log("Fetch timeout :", FETCH_TIMEOUT_MS, "ms");

// premier tick immédiat
tick().catch((err) => {
  console.error("Erreur premier tick :", err.message);
});

// puis toutes les 3 secondes exactes
setInterval(() => {
  tick().catch((err) => {
    console.error("Erreur interval tick :", err.message);
  });
}, INTERVAL_MS);
