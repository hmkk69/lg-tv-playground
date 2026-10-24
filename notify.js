const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const tv = require("lgtv2");

const cfip = path.join(__dirname, "tv-ip.txt");

async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer;
}

async function get_tv_ip() {
  const ip = await ask("Enter TV IP: ");
  if (!ip) {
    throw new Error("TV IP is required");
  }
  return ip;
}

async function get_msg() {
  const message = await ask("Enter message: ");
  return message || "Hi from PC";
}

function connect_tv(ip) {
  return new Promise((resolve) => {
    const t_v = new tv({
      host: ip,
      timeout: 10000,
    });

    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        t_v.disconnect();
      } catch {}
      resolve(ok);
    };

    const timer = setTimeout(() => {
      finish(false);
    }, 15000);

    t_v.on("connect", () => {
      finish(true);
    });

    t_v.on("prompt", () => {
      console.log("Please accept the connection on the TV if prompted.");
    });

    t_v.on("error", (err) => {
      console.error("Error:", err.message || err);
      finish(false);
    });

    t_v.on("close", () => {
      if (!settled) {
        finish(false);
      }
    });
  });
}

function send_toast(ip, message) {
  return new Promise((resolve) => {
    const t_v = new tv({
      host: ip,
      timeout: 10000,
    });

    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        t_v.disconnect();
      } catch {}
      resolve(ok);
    };

    const timer = setTimeout(() => {
      finish(false);
    }, 15000);

    t_v.on("connect", () => {
      t_v.request(
        "ssap://system.notifications/createToast",
        { message: message },
        (err, result) => {
          if (err) {
            console.error("TV rejected command:", err.message || err);
            finish(false);
          } else {
            console.log("TV response:", result);
            finish(true);
          }
        }
      );
    });

    t_v.on("prompt", () => {
      console.log("Please accept the connection on the TV if prompted.");
    });

    t_v.on("error", (err) => {
      console.error("Error:", err.message || err);
      finish(false);
    });

    t_v.on("close", () => {
      if (!settled) {
        finish(false);
      }
    });
  });
}

async function main() {
  let ip = "";

  if (fs.existsSync(cfip)) {
    const saved_ip = fs.readFileSync(cfip, "utf8").trim();

    if (saved_ip && (await connect_tv(saved_ip))) {
      ip = saved_ip;
      console.log("Connected to TV " + ip + " (from saved config)");
    } else {
      console.log("Saved IP could not connect. Please enter a new IP.");
      ip = await get_tv_ip();

      if (!(await connect_tv(ip))) {
        throw new Error("Could not connect to TV.");
      }

      fs.writeFileSync(cfip, ip, "utf8");
      console.log("Connected to TV " + ip);
    }
  } else {
    ip = await get_tv_ip();

    if (!(await connect_tv(ip))) {
      throw new Error("Could not connect to TV.");
    }

    fs.writeFileSync(cfip, ip, "utf8");
    console.log("Connected to TV " + ip);
  }

  const msg = await get_msg();
  const ok = await send_toast(ip, msg);

  if (!ok) {
    throw new Error("Failed to send notification.");
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
