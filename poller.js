import http from "http";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://fkcnhgdzpqbbcudoyjhn.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrY25oZ2R6cHFiYmN1ZG95amhuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjA1NzUwMCwiZXhwIjoyMDg3NjMzNTAwfQ.slS-vZkGoCpWoncM9r7etTfqJ5e5sTi2WkkQhoYRg3Q";
const SERVER_URI = "https://shelly-165-eu.shelly.cloud";
const AUTH_KEY = "MmVkMWVidWlk2CAB39DBD5697035A61BC935AA12DF1D78A1196C36B19FB1B6AA4B8FB72062AB450CE001DBB77341";

const SHELLY_DEVICE_IDS = [
  "f1b457",
  "f1b3d3",
  "7c87cebaa2ca",
  "7c87ceb512a6",
  "7c87ceb4811e",
];

const START_W = 5;
const STOP_W = 3;

const INTERVAL_MS = 5000; // ⏱ 5 secondes
const FETCH_TIMEOUT_MS = 15000;
const PORT = 8080;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TAG_TO_DBID = {
  f1b457: "F1",
  f1b3d3: "F2",
  "7c87cebaa2ca": "F3",
  "7c87ceb512a6": "F4",
  "7c87ceb4811e": "F5",
};

let running = false;
let pollCount = 0;

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

    const data = await res.json();
    return data;
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

async function getState(device_id) {
  const { data } = await supabase
    .from("device_state")
    .select("*")
    .eq("device_id", device_id)
    .maybeSingle();

  return (
    data || {
      device_id,
      active: false,
      open_start_ms: null,
    }
  );
}

async function saveState(st) {
  await supabase.from("device_state").upsert(
    {
      device_id: st.device_id,
      active: st.active,
      open_start_ms: st.open_start_ms,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "device_id" }
  );
}

async function insertSessionStart(device_id, start_ms, start_w) {
  await supabase.from("sessions").insert({
    device_id,
    start_ms,
    start_w,
  });
}

async function updateSessionStop(device_id, start_ms, end_ms, end_w) {
  const duration_sec = Math.round((end_ms - start_ms) / 1000);

  await supabase
    .from("sessions")
    .update({ end_ms, end_w, duration_sec })
    .eq("device_id", device_id)
    .eq("start_ms", start_ms)
    .is("end_ms", null);
}

async function pollOne(tag) {
  const ts = nowMs();
  const device_id = TAG_TO_DBID[tag] || tag;

  const status = await fetchDeviceStatus(tag);
  const power = extractPower(status);

  const st = await getState(device_id);

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

  return { device_id, power, active: st.active };
}

async function tick() {
  if (running) return;

  running = true;
  pollCount++;

  console.log("--------------------------------------------------");
  console.log(`[POLL ${pollCount}] ${new Date().toISOString()}`);

  try {
    for (const tag of SHELLY_DEVICE_IDS) {
      const r = await pollOne(tag);
      console.log(r);
    }
  } catch (e) {
    console.error("Erreur:", e.message);
  }

  running = false;
}

function main() {
  console.log("Poller démarré");
  console.log("Interval :", INTERVAL_MS, "ms");

  tick();
  setInterval(tick, INTERVAL_MS);
}

http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("Poller running");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log("Server HTTP :", PORT);
  });

main();
