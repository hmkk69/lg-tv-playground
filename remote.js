const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const LGTV = require("lgtv2");

const app = express();
const CONFIG_FILE = path.join(__dirname, "tv-ip.txt");
const PORT = 8787;

app.use(express.json({ limit: "32kb" }));

let tv = null;
let pointer = null;
let tvHost = "";
let connected = false;
let lastError = "";
let latestVolume = null;
let latestPower = null;
let appsCache = [];
let inputsCache = [];

let savedHost = "";
try {
  if (fs.existsSync(CONFIG_FILE)) {
    savedHost = fs.readFileSync(CONFIG_FILE, "utf8").trim();
  }
} catch {}
if (savedHost) {
  tvHost = savedHost;
}

function requireTV() {
  if (!tv || !connected) {
    throw new Error("TV is not connected. Enter an IP and connect first.");
  }
  return tv;
}

function sendError(res, err) {
  res.status(400).json({
    ok: false,
    error: err?.message || String(err),
  });
}

app.get("/api/status", (req, res) => {
  res.json({
    connected,
    host: tvHost,
    error: lastError,
    volume: latestVolume,
    power: latestPower,
  });
});

app.post("/api/connect", async (req, res) => {
  const host = String(req.body?.host || "").trim();

  if (
    !host ||
    host.length > 253 ||
    !/^[a-zA-Z0-9.-]+$/.test(host) ||
    host.startsWith(".") ||
    host.endsWith(".")
  ) {
    return res.status(400).json({
      ok: false,
      error: "Enter a valid TV IP address or hostname.",
    });
  }

  try {
    if (tv) {
      try {
        await tv.disconnect();
      } catch {}
    }

    tv = null;
    pointer = null;
    connected = false;
    lastError = "";
    latestVolume = null;
    latestPower = null;
    tvHost = host;

    const instance = new LGTV({
      host,
      timeout: 12000,
      handshakeTimeout: 10000,
      reconnect: 5000,
    });

    tv = instance;

    instance.on("prompt", () => {
      console.log("Please accept the connection request on the TV.");
    });

    instance.on("error", (err) => {
      lastError = err?.message || String(err);
      console.log("TV error:", lastError);
    });

    instance.on("close", () => {
      connected = false;
      pointer = null;
    });

    await new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        finish(new Error(
          "Connection timed out. Check the IP, network, and pairing permission."
        ));
      }, 25000);

      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        instance.off("connect", onConnect);
        if (err) reject(err);
        else resolve();
      }

      function onConnect() {
        connected = true;
        lastError = "";
        finish();
      }

      instance.on("connect", onConnect);
    });

    try {
      latestVolume = await instance.request("ssap://audio/getVolume");
    } catch (err) {
      console.log("Could not read volume:", err.message);
    }

    try {
      latestPower = await instance.getPowerState();
    } catch {}

    try {
      fs.writeFileSync(CONFIG_FILE, host, "utf8");
    } catch {}

    res.json({
      ok: true,
      message: "Connected to TV.",
      host,
      volume: latestVolume,
      power: latestPower,
    });
  } catch (err) {
    connected = false;
    lastError = err?.message || String(err);
    sendError(res, err);
  }
});

app.post("/api/key", async (req, res) => {
  try {
    requireTV();

    const allowed = new Set([
      "UP", "DOWN", "LEFT", "RIGHT", "ENTER",
      "BACK", "EXIT", "HOME", "MENU", "INFO",
      "PLAY", "PAUSE", "STOP", "REWIND",
      "FASTFORWARD", "VOLUMEUP", "VOLUMEDOWN",
      "MUTE", "CHANNELUP", "CHANNELDOWN",
      "RED", "GREEN", "YELLOW", "BLUE",
      "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    ]);

    const key = String(req.body?.key || "").toUpperCase();

    if (!allowed.has(key)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid key.",
      });
    }

    if (!pointer) {
      pointer = await tv.getSocket(
        "ssap://com.webos.service.networkinput/getPointerInputSocket"
      );
    }

    pointer.send("button", { name: key });
    res.json({ ok: true, message: `Sent key ${key}` });
  } catch (err) {
    pointer = null;
    sendError(res, err);
  }
});

app.post("/api/action", async (req, res) => {
  try {
    const client = requireTV();
    const action = String(req.body?.action || "");

    let result;

    switch (action) {
      case "volume":
        result = await client.request("ssap://audio/getVolume");
        latestVolume = result;
        break;

      case "mute": {
        const current = await client.request("ssap://audio/getVolume");
        const muted = Boolean(current.muted);
        result = await client.request("ssap://audio/setMute", {
          mute: !muted,
        });
        latestVolume = { ...current, muted: !muted };
        break;
      }

      case "apps":
        result = await client.request(
          "ssap://com.webos.applicationManager/listLaunchPoints"
        );
        appsCache = result.launchPoints || [];
        break;

      case "inputs":
        result = await client.request("ssap://tv/getExternalInputList");
        inputsCache = result.devices || [];
        break;

      case "power":
        result = await client.getPowerState();
        latestPower = result;
        break;

      case "off":
        result = await client.request("ssap://system/turnOff");
        break;

      case "wake":
        result = await client.wake();
        break;

      case "youtube":
        result = await client.request(
          "ssap://com.webos.applicationManager/launch",
          { id: "youtube.leanback.v4" }
        );
        break;

      case "browser":
        result = await client.request("ssap://system.launcher/open", {
          target: `http://${getLanIP()}:${PORT}/`,
        });
        break;

      default:
        return res.status(400).json({
          ok: false,
          error: "Unsupported action.",
        });
    }

    res.json({
      ok: true,
      result,
      apps: action === "apps" ? appsCache : undefined,
      inputs: action === "inputs" ? inputsCache : undefined,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/launch", async (req, res) => {
  try {
    const client = requireTV();
    const id = String(req.body?.id || "").trim();

    if (!id || !appsCache.some((item) => item.id === id)) {
      return res.status(400).json({
        ok: false,
        error: "Load the app list and choose a valid app.",
      });
    }

    const result = await client.request(
      "ssap://com.webos.applicationManager/launch",
      { id }
    );

    res.json({ ok: true, result });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/input", async (req, res) => {
  try {
    const client = requireTV();
    const id = String(req.body?.id || "").trim();

    if (!id || !inputsCache.some((item) => item.id === id)) {
      return res.status(400).json({
        ok: false,
        error: "Load the input list first.",
      });
    }

    const result = await client.request("ssap://tv/switchInput", {
      inputId: id,
    });

    res.json({ ok: true, result });
  } catch (err) {
    sendError(res, err);
  }
});

function getLanIP() {
  const os = require("node:os");
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) {
        return item.address;
      }
    }
  }

  return "127.0.0.1";
}

app.get("/", (req, res) => {
  res.type("html").send(HTML);
});

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LG TV Remote</title>
<style>
:root{color-scheme:light;--bg:#eef3f8;--surface:#fff;--surface-2:#f7f9fb;--line:#d9e1e8;
--text:#14202b;--muted:#64748b;--accent:#a50034;--accent-dark:#85002a;--ok:#16a34a;
--remote:#1b1c20;--remote-2:#26272c;--remote-line:#3a3b42;--remote-text:#f5f5f5;--remote-muted:#a1a1aa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;min-height:100vh}
button{font:inherit;cursor:pointer;transition:background .12s,border-color .12s,color .12s}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wrap{max-width:1080px;margin:0 auto;padding:26px 20px 44px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:16px}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:34px;height:34px;display:block;object-fit:contain}
.brand-text h1{font-size:20px;margin:0;line-height:1.2;letter-spacing:-.02em}
.brand-text p{margin:2px 0 0;color:var(--muted);font-size:12px}
.status{display:flex;align-items:center;gap:7px;background:var(--surface);border:1px solid var(--line);
border-radius:6px;padding:6px 10px;font-size:12px;color:var(--muted);white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:#94a3b8}
.dot.on{background:var(--ok)}
.connect-card{background:var(--surface);border:1px solid var(--line);border-radius:8px;
padding:14px;margin-bottom:16px;box-shadow:0 1px 2px rgba(20,32,43,.04)}
.connect-field{max-width:560px}
label{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;
text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.connect{display:flex;gap:8px}
input{min-width:0;width:100%;background:var(--surface);color:var(--text);border:1px solid var(--line);
border-radius:6px;padding:9px 11px;font:inherit;outline:none}
input:focus{border-color:var(--accent)}
button.primary{background:var(--accent);border:1px solid var(--accent);color:#fff;
border-radius:6px;padding:9px 16px;font-weight:600;white-space:nowrap}
button.primary:hover{background:var(--accent-dark);border-color:var(--accent-dark)}
button.primary:disabled{opacity:.55;cursor:not-allowed}
.layout{display:grid;grid-template-columns:340px minmax(0,1fr);gap:16px;align-items:start}
.side{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.side .card:last-child{grid-column:1/-1}
.remote{background:var(--remote);border:1px solid #101114;border-radius:22px;padding:18px 16px;
width:100%;max-width:340px;margin:0 auto;box-shadow:0 20px 40px rgba(15,23,42,.18)}
.remote-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.remote-name{display:flex;align-items:center;gap:7px;font-size:10px;letter-spacing:.14em;
text-transform:uppercase;color:var(--remote-muted)}
.led{width:6px;height:6px;border-radius:50%;background:var(--ok)}
.power-btn{width:34px;height:34px;border-radius:6px;border:1px solid var(--remote-line);
background:transparent;color:#fca5a5;font-size:15px;padding:0}
.power-btn:hover{background:#3a1d22;border-color:#5a2a32}
.dpad{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;width:210px;margin:0 auto 14px}
.key{aspect-ratio:1;display:grid;place-items:center;background:var(--remote-2);
border:1px solid var(--remote-line);color:var(--remote-text);border-radius:8px;font-size:16px;padding:0}
.key:hover{background:#33343a}
.key:active{background:#1f2024}
.key.center{border-radius:50%;background:#f4f4f5;color:#18181b;border-color:#f4f4f5;
font-weight:700;font-size:13px}
.key.blank{visibility:hidden;border:0;background:transparent}
.fn-row{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:14px}
.fn-row button{background:transparent;border:1px solid var(--remote-line);color:#d4d4d8;
border-radius:6px;font-size:10px;padding:7px 2px}
.fn-row button:hover{background:#2b2c31}
.vol-row{display:grid;grid-template-columns:42px 1fr 42px;gap:7px;align-items:center;margin-bottom:10px}
.vol-row button{height:42px;padding:0;font-size:18px;border-radius:8px;
background:var(--remote-2);border:1px solid var(--remote-line);color:var(--remote-text)}
.vol-row button:hover{background:#33343a}
.vol-readout{text-align:center;color:var(--remote-text);line-height:1}
.vol-readout strong{display:block;font-size:20px;font-weight:700}
.vol-readout small{display:block;font-size:9px;letter-spacing:.12em;
text-transform:uppercase;color:var(--remote-muted);margin-top:3px}
.media-row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.media-row button{height:40px;padding:0;border-radius:8px;background:var(--remote-2);
border:1px solid var(--remote-line);color:var(--remote-text);font-size:14px}
.media-row button:hover{background:#33343a}
.sync-btn{width:100%;margin-top:9px;padding:7px;font-size:11px;background:transparent;
border:1px solid var(--remote-line);color:var(--remote-muted);border-radius:6px}
.sync-btn:hover{background:#2b2c31;color:var(--remote-text)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px;
box-shadow:0 1px 2px rgba(20,32,43,.04);min-width:0}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.card h2{font-size:13px;margin:0}
.ghost{background:transparent;border:1px solid var(--line);color:var(--text);
font-size:11px;padding:5px 9px;border-radius:5px;font-weight:600}
.ghost:hover{background:var(--surface-2)}
.list{display:grid;gap:5px;max-height:260px;overflow:auto}
.item{display:flex;align-items:center;justify-content:space-between;gap:10px;
background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:8px 9px}
.item .name{min-width:0;overflow-wrap:anywhere;font-size:13px}
.item button{font-size:11px;padding:5px 8px;background:var(--surface);
border:1px solid var(--line);color:var(--text);border-radius:5px;font-weight:600}
.item button:hover{background:#eef2f6}
.empty{color:var(--muted);font-size:13px;margin:0}
.power-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.power-grid button{font-size:12px;padding:8px 6px;background:var(--surface);
border:1px solid var(--line);color:var(--text);border-radius:5px;font-weight:600}
.power-grid button:hover{background:var(--surface-2)}
.power-grid .span-2{grid-column:1/-1}
.msg{font-size:12px;min-height:16px;margin:8px 0 0;color:var(--muted);overflow-wrap:anywhere}
.msg.err{color:#b42318}
.remote .msg{text-align:center;margin:10px 0 0;color:var(--remote-muted)}
.remote .msg.err{color:#fca5a5}
@media(max-width:820px){.layout{grid-template-columns:1fr}.remote{max-width:360px}
.side{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.side{grid-template-columns:1fr}.wrap{padding:18px 14px 32px}
.topbar{align-items:flex-start}.status{font-size:11px}.connect{flex-direction:column}
button.primary{width:100%}}
</style>
</head>
<body>
<div class="wrap">
<header class="topbar">
 <div class="brand">
  <img class="logo" src="https://upload.wikimedia.org/wikipedia/commons/2/20/LG_symbol.svg" alt="LG">
  <div class="brand-text"><h1>TV Remote</h1><p>webOS control panel</p></div>
 </div>
 <div class="status"><span class="dot" id="dot"></span><span id="state">Disconnected</span></div>
</header>

<section class="connect-card">
 <div class="connect-field">
  <label for="host">TV address</label>
  <div class="connect">
   <input id="host" placeholder="192.168.1.50" autocomplete="off">
   <button class="primary" id="connect">Connect</button>
  </div>
  <p class="msg" id="connectMsg"></p>
 </div>
</section>

<main class="layout">
 <section class="remote" aria-label="Remote control">
  <div class="remote-top">
   <div class="remote-name"><span class="led"></span>webOS</div>
   <button class="power-btn" id="off" title="Turn off TV" aria-label="Turn off TV">⏻</button>
  </div>

  <div class="dpad">
   <button class="key blank" tabindex="-1"></button>
   <button class="key" data-key="UP" aria-label="Up">▲</button>
   <button class="key blank" tabindex="-1"></button>
   <button class="key" data-key="LEFT" aria-label="Left">◀</button>
   <button class="key center" data-key="ENTER">OK</button>
   <button class="key" data-key="RIGHT" aria-label="Right">▶</button>
   <button class="key blank" tabindex="-1"></button>
   <button class="key" data-key="DOWN" aria-label="Down">▼</button>
   <button class="key blank" tabindex="-1"></button>
  </div>

  <div class="fn-row">
   <button data-key="BACK">Back</button>
   <button data-key="HOME">Home</button>
   <button data-key="MENU">Menu</button>
   <button data-key="INFO">Info</button>
   <button data-key="EXIT">Exit</button>
  </div>

  <div class="vol-row">
   <button data-key="VOLUMEDOWN" aria-label="Volume down">−</button>
   <div class="vol-readout"><strong id="volume">—</strong><small>Volume</small></div>
   <button data-key="VOLUMEUP" aria-label="Volume up">+</button>
  </div>

  <div class="media-row">
   <button data-key="REWIND" aria-label="Rewind">◀◀</button>
   <button data-key="PLAY" aria-label="Play">▶</button>
   <button data-key="PAUSE" aria-label="Pause">❚❚</button>
   <button data-key="MUTE" aria-label="Mute">Mute</button>
  </div>

  <button class="sync-btn" id="refreshVolume">Refresh volume</button>
  <p class="msg" id="remoteMsg"></p>
 </section>

 <div class="side">
  <section class="card">
   <div class="card-head"><h2>Apps</h2><button class="ghost" id="loadApps">Refresh</button></div>
   <div class="list" id="apps"><p class="empty">Connect to load apps.</p></div>
   <p class="msg" id="appsMsg"></p>
  </section>

  <section class="card">
   <div class="card-head"><h2>Inputs</h2><button class="ghost" id="loadInputs">Refresh</button></div>
   <div class="list" id="inputs"><p class="empty">Connect to load inputs.</p></div>
   <p class="msg" id="inputsMsg"></p>
  </section>

  <section class="card">
   <div class="card-head"><h2>Power</h2></div>
   <div class="power-grid">
    <button id="power">Status</button>
    <button id="wake">Wake</button>
    <button id="browser" class="span-2">Open remote on TV</button>
   </div>
   <p class="msg" id="powerMsg"></p>
  </section>
 </div>
</main>
</div>

<script>
const $ = id => document.getElementById(id);
let isConnected = false;

async function api(path, body) {
 const res = await fetch(path, {
  method: body === undefined ? "GET" : "POST",
  headers: {"Content-Type":"application/json"},
  body: body === undefined ? undefined : JSON.stringify(body)
 });
 const data = await res.json();
 if (!res.ok || data.ok === false) throw new Error(data.error || "Request failed");
 return data;
}

function message(id, text, error=false) {
 const el = $(id);
 el.textContent = text || "";
 el.className = "msg" + (error ? " err" : "");
}
function setState(on, text) {
 isConnected = on;
 $("dot").classList.toggle("on", on);
 $("state").textContent = text;
}
function ensureConnected() {
 if (!isConnected) throw new Error("Connect to the TV first.");
}

async function refreshStatus() {
 try {
  const s = await api("/api/status");
  if (s.connected) setState(true, "Connected · " + s.host);
  else if (isConnected) setState(false, "Connection lost");
  if (!s.connected && s.host && !$("host").value) {
   $("host").value = s.host;
  }
  if (s.volume && Number.isFinite(Number(s.volume.volume))) {
   $("volume").textContent = s.volume.volume;
  }
 } catch {}
}

$("connect").onclick = async () => {
 const host = $("host").value.trim();
 if (!host) return message("connectMsg", "Enter the TV IP first.", true);
 $("connect").disabled = true;
 message("connectMsg", "Connecting… accept the prompt on the TV if asked.");
 try {
  const d = await api("/api/connect", {host});
  setState(true, "Connected · " + host);
  message("connectMsg", d.message);
  await getVolume();
 } catch(e) {
  setState(false, "Disconnected");
  message("connectMsg", e.message, true);
 } finally { $("connect").disabled = false; }
};

async function sendKey(key) {
 try {
  ensureConnected();
  await api("/api/key", {key});
  message("remoteMsg", "Sent: " + key);
  if (key.startsWith("VOLUME") || key === "MUTE") {
   setTimeout(getVolume, 400);
  }
 } catch(e) { message("remoteMsg", e.message, true); }
}
document.querySelectorAll("[data-key]").forEach(b => {
 b.addEventListener("click", () => sendKey(b.dataset.key));
});

async function getVolume() {
 try {
  ensureConnected();
  const d = await api("/api/action", {action:"volume"});
  const v = d.result?.volume;
  $("volume").textContent = Number.isFinite(Number(v)) ? v : "—";
  message("remoteMsg", "Volume refreshed.");
 } catch(e) { message("remoteMsg", e.message, true); }
}
$("refreshVolume").onclick = getVolume;

$("loadApps").onclick = async () => {
 try {
  ensureConnected();
  message("appsMsg", "Loading apps…");
  const d = await api("/api/action", {action:"apps"});
  $("apps").replaceChildren();
  (d.apps || []).forEach(a => {
   const row = document.createElement("div");
   row.className = "item";
   const name = document.createElement("div");
   name.className = "name";
   name.textContent = a.title || a.id;
   const btn = document.createElement("button");
   btn.textContent = "Open";
   btn.onclick = async () => {
    try {
     await api("/api/launch", {id:a.id});
     message("appsMsg", "Launch command sent for " + (a.title || a.id));
    } catch(e) { message("appsMsg", e.message, true); }
   };
   row.append(name, btn);
   $("apps").append(row);
  });
  if (!d.apps?.length) $("apps").textContent = "The TV did not return an app list.";
  message("appsMsg", "Found " + (d.apps || []).length + " apps.");
 } catch(e) { message("appsMsg", e.message, true); }
};

$("loadInputs").onclick = async () => {
 try {
  ensureConnected();
  const d = await api("/api/action", {action:"inputs"});
  $("inputs").replaceChildren();
  (d.inputs || []).forEach(i => {
   const row = document.createElement("div");
   row.className = "item";
   const name = document.createElement("div");
   name.className = "name";
   name.textContent = (i.label || i.id) + (i.connected ? " · Connected" : "");
   const btn = document.createElement("button");
   btn.textContent = "Switch";
   btn.onclick = async () => {
    try {
     await api("/api/input", {id:i.id});
     message("inputsMsg", "Switch request sent for " + (i.label || i.id));
    } catch(e) { message("inputsMsg", e.message, true); }
   };
   row.append(name, btn);
   $("inputs").append(row);
  });
  if (!d.inputs?.length) $("inputs").textContent = "No inputs returned.";
  message("inputsMsg", "Loaded " + (d.inputs || []).length + " inputs.");
 } catch(e) { message("inputsMsg", e.message, true); }
};

$("power").onclick = async () => {
 try {
  ensureConnected();
  const d = await api("/api/action", {action:"power"});
  message("powerMsg", "Status: " + (d.result?.state || JSON.stringify(d.result)));
 } catch(e) { message("powerMsg", e.message, true); }
};
$("off").onclick = async () => {
 if (!confirm("Turn off the TV?")) return;
 try {
  await api("/api/action", {action:"off"});
  message("powerMsg", "Power off command sent.");
 } catch(e) { message("powerMsg", e.message, true); }
};
$("wake").onclick = async () => {
 try {
  await api("/api/action", {action:"wake"});
  message("powerMsg", "Wake-on-LAN packet sent.");
 } catch(e) {
  message("powerMsg", e.message + " — Wake-on-LAN and pairing may need to be enabled first.", true);
 }
};
$("browser").onclick = async () => {
 try {
  await api("/api/action", {action:"browser"});
  message("powerMsg", "Asked the TV to open the PC remote page.");
 } catch(e) { message("powerMsg", e.message, true); }
};

setInterval(refreshStatus, 4000);
refreshStatus();
</script>
</body>
</html>`;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LG TV Remote: http://localhost:${PORT}`);
  console.log(`Open from a phone on the same Wi-Fi: http://${getLanIP()}:${PORT}`);
  console.log("Enter the TV IP in the UI to connect.");
});
