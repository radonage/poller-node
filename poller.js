import http from "http";

const PORT = process.env.PORT || 8080;

const SERVER_URI =
  process.env.SHELLY_SERVER_URI || "https://shelly-165-eu.shelly.cloud";
const AUTH_KEY =
  process.env.SHELLY_AUTH_KEY ||
  "REMPLACE_PAR_TA_NOUVELLE_CLE";

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

const START_W = 5;
const STOP_W = 3;

const INTERVAL_MS = 10000;
const BETWEEN_DEVICES_MS = 1500;

const ACTIVE_FROM = 8;
const ACTIVE_TO = 24;

const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES_429 = 2;
const RETRY_429_MS = 4000;

const stateMap = {};
let lastResponse = null;
let running = false;
let scanCount = 0;

function inActiveWindow() {
  const h = new Date().getHours();
  return h >= ACTIVE_FROM && h < ACTIVE_TO;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowMs() {
  return Date.now();
}

function getLocalState(device_id) {
  if (!stateMap[device_id]) {
    stateMap[device_id] = {
      active: false,
      open_start_ms: null,
    };
  }
  return stateMap[device_id];
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

    const text = await res.text();

    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Réponse non JSON: ${text}`);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDeviceStatusWithRetry(tag) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
    try {
      return await fetchDeviceStatus(tag);
    } catch (e) {
      lastError = e;
      const msg = String(e?.message || e);

      if (msg.includes("HTTP 429")) {
        console.log(
          `[${TAG_TO_DBID[tag] || tag}] 429 -> attente ${RETRY_429_MS} ms`
        );
        await sleep(RETRY_429_MS);
        continue;
      }

      throw e;
    }
  }

  throw lastError;
}

async function pollOneDevice(shellyTag) {
  const ts = nowMs();
  const device_id = TAG_TO_DBID[shellyTag] || shellyTag;

  const status = await fetchDeviceStatusWithRetry(shellyTag);
  const power = extractPower(status);

  if (!Number.isFinite(power)) {
    return {
      ok: false,
      ts,
      shellyTag,
      device_id,
      error: "POWER_NOT_FOUND",
    };
  }

  const st = getLocalState(device_id);

  if (!st.active && power > START_W) {
    st.active = true;
    st.open_start_ms = ts;
  } else if (st.active && power < STOP_W) {
    st.active = false;
    st.open_start_ms = null;
  }

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
    console.log("⏳ Scan déjà en cours, tick ignoré");
    return lastResponse;
  }

  running = true;
  scanCount++;

  console.log("--------------------------------------------------");
  console.log(`⏱ Scan #${scanCount} :`, new Date().toLocaleString());

  try {
    if (!inActiveWindow()) {
      console.log("⏸ Hors plage horaire...");

      lastResponse = {
        ok: true,
        count: 0,
        results: [],
        skipped: true,
        reason: "OUTSIDE_ACTIVE_WINDOW",
      };

      return lastResponse;
    }

    const results = [];

    for (const tag of SHELLY_DEVICE_IDS) {
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

      await sleep(BETWEEN_DEVICES_MS);
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

function main() {
  console.log("Poller direct Shelly démarré...");
  console.log("PORT =", PORT);
  console.log("INTERVAL_MS =", INTERVAL_MS);
  console.log("BETWEEN_DEVICES_MS =", BETWEEN_DEVICES_MS);

  tick();
  setInterval(tick, INTERVAL_MS);
}

http
  .createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
      return;
    }

    if (req.url === "/last") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
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
