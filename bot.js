import bedrock from "bedrock-protocol";

const HOST = process.env.SERVER_HOST;
const PORT = parseInt(process.env.SERVER_PORT || "19132", 10);
const EMAIL = process.env.MS_EMAIL;
const VERSION = process.env.BEDROCK_VERSION || "1.26.40";
const AUTH_DIR = process.env.AUTH_DIR || "./auth";
const CI = process.env.CI === "true";
const LOGIN_ONLY = process.env.LOGIN_ONLY === "1";

if (!HOST || !EMAIL) {
  console.error("SERVER_HOST atau MS_EMAIL belum diisi");
  keluar(3);
}

const KECEPATAN = 0.2158;
const LANGKAH = 14;
const JEDA_MS = 60000;
const YAW = 0;
const MODEL_INTERAKSI = ["classic", "touch", "crosshair"];

let posisi = null;
let awal = null;
let runtimeId = null;
let tick = 0n;
let siap = false;
let gerakAktif = true;
let galat = 0;
let idxModel = 0;
let fase = "diam";
let sisa = 0;
let vy = 0;
let y0 = 0;
let mulaiLompat = false;

const NTFY = process.env.NTFY_TOPIC;
const sudahKirim = new Map();
let jumlahJam = 0;
setInterval(() => {
  jumlahJam = 0;
}, 3600000);

function keLog(teks) {
  if (!NTFY) return;
  let t = String(teks);
  if (HOST) t = t.split(HOST).join("***");
  t = t.slice(0, 300);
  const sekarang = Date.now();
  if ((sudahKirim.get(t) ?? 0) > sekarang - 60000) return;
  if (jumlahJam >= 100) return;
  sudahKirim.set(t, sekarang);
  jumlahJam++;
  fetch("https://ntfy.sh/" + NTFY, { method: "POST", body: "[+" + Math.round(process.uptime()) + "s] " + t }).catch(() => {});
}

function keluar(kode) {
  setTimeout(() => process.exit(kode), 2000);
}

const logAsli = console.log;
const errAsli = console.error;
console.log = (...a) => {
  logAsli(...a);
  keLog(a.map((x) => x?.message ?? x).join(" "));
};
console.error = (...a) => {
  errAsli(...a);
  keLog("ERROR: " + a.map((x) => x?.message ?? x).join(" "));
};
console.log("Bot mulai, mencoba masuk server...");

process.on("uncaughtException", (e) => {
  console.error("Error tak tertangkap:", e?.message ?? e);
  keluar(1);
});

let client;
try {
  client = bedrock.createClient({
    host: HOST,
    port: PORT,
    version: VERSION,
    username: EMAIL,
    offline: false,
    profilesFolder: AUTH_DIR,
    ...(process.env.RAKNET_BACKEND ? { raknetBackend: process.env.RAKNET_BACKEND } : {}),
    connectTimeout: 30000,
    conLog: (...a) => console.log(...a),
    onMsaCode: (kode) => {
      if (CI) {
        console.error("Login Microsoft perlu diulang: jalankan bash ~/mc-login.sh di Termux");
        keluar(2);
      }
      console.log(kode.message ?? `Buka https://www.microsoft.com/link dan masukkan kode ${kode.user_code}`);
    },
  });
} catch (e) {
  console.error("Gagal membuat koneksi:", e?.message ?? e);
  keluar(3);
}

if (LOGIN_ONLY) {
  setTimeout(() => {
    console.error("Belum berhasil masuk server dalam 15 menit");
    keluar(1);
  }, 900000);
}

function kirim(flags, mv, delta) {
  tick += 1n;
  const paket = {
    pitch: 0,
    yaw: YAW,
    position: { x: posisi.x, y: posisi.y, z: posisi.z },
    move_vector: mv,
    head_yaw: YAW,
    input_data: flags,
    input_mode: "mouse",
    play_mode: "screen",
    interaction_model: MODEL_INTERAKSI[idxModel],
    interact_rotation: { x: 0, z: YAW },
    tick,
    delta,
    analogue_move_vector: mv,
    camera_orientation: { x: 0, y: 0, z: 1 },
    raw_move_vector: mv,
  };
  try {
    client.write("player_auth_input", paket);
    galat = 0;
  } catch (e) {
    galat++;
    idxModel = (idxModel + 1) % MODEL_INTERAKSI.length;
    if (galat <= 3) console.error("Gagal kirim gerakan:", e?.message ?? e);
    if (galat >= 6) {
      gerakAktif = false;
      console.error("Gerakan dimatikan karena format paket tidak cocok, bot tetap AFK di server");
    }
  }
}

function langkah() {
  if (!siap || !posisi || !gerakAktif || process.env.GERAK === "0") return;
  let flags = {};
  let mv = { x: 0, z: 0 };
  const delta = { x: 0, y: 0, z: 0 };

  if (fase === "maju") {
    posisi.z += KECEPATAN;
    delta.z = KECEPATAN;
    flags = { up: true };
    mv = { x: 0, z: 1 };
    if (--sisa <= 0) fase = "mundur";
  } else if (fase === "mundur") {
    const jarak = posisi.z - awal.z;
    if (jarak > 0.0005) {
      const s = Math.min(KECEPATAN, jarak);
      posisi.z -= s;
      delta.z = -s;
      flags = { down: true };
      mv = { x: 0, z: -1 };
    }
    if (posisi.z - awal.z <= 0.0005) {
      posisi.z = awal.z;
      fase = "lompat";
      vy = 0.42;
      y0 = posisi.y;
      mulaiLompat = true;
    }
  } else if (fase === "lompat") {
    const yLama = posisi.y;
    if (mulaiLompat) {
      flags = {
        jump_down: true,
        jumping: true,
        start_jumping: true,
        jump_pressed_raw: true,
        jump_current_raw: true,
      };
      mulaiLompat = false;
    }
    posisi.y += vy;
    vy = (vy - 0.08) * 0.98;
    if (posisi.y <= y0 + 0.0001 && vy < 0) {
      posisi.y = y0;
      vy = 0;
      fase = "diam";
    }
    delta.y = posisi.y - yLama;
  }
  kirim(flags, mv, delta);
}

function mulaiGerak() {
  if (fase === "diam" && siap && gerakAktif) {
    fase = "maju";
    sisa = LANGKAH;
  }
}

client.on("join", () => console.log("Login diterima server"));

client.on("start_game", (p) => {
  runtimeId = p.runtime_entity_id;
  if (p.player_position) {
    posisi = { x: p.player_position.x, y: p.player_position.y, z: p.player_position.z };
  }
  tick = BigInt(p.current_tick ?? 0);
});

client.on("correct_player_move_prediction", (p) => {
  if (p?.position) posisi = { x: p.position.x, y: p.position.y, z: p.position.z };
});

client.on("move_player", (p) => {
  const id = p.runtime_id ?? p.runtime_entity_id;
  if (runtimeId !== null && String(id) === String(runtimeId) && p.position) {
    posisi = { x: p.position.x, y: p.position.y, z: p.position.z };
  }
});

client.on("spawn", () => {
  console.log("Bot masuk server");
  if (LOGIN_ONLY) {
    console.log("Login tersimpan");
    setTimeout(() => keluar(0), 3000);
    return;
  }
  if (!posisi) {
    console.error("Posisi awal tidak diketahui, bot tetap AFK tanpa gerak");
    return;
  }
  awal = { ...posisi };
  console.log("Posisi awal:", Math.round(posisi.x), Math.round(posisi.y), Math.round(posisi.z), "gerakan", process.env.GERAK === "0" ? "MATI" : "aktif");
  siap = true;
  setInterval(langkah, 50);
  setTimeout(() => {
    mulaiGerak();
    setInterval(mulaiGerak, JEDA_MS);
  }, 15000);
});

client.on("kick", (p) => {
  console.error("Dikeluarkan dari server:", JSON.stringify(p).slice(0, 200));
  keluar(4);
});
client.on("close", (alasan) => {
  console.error("Koneksi terputus", alasan ?? "");
  keluar(1);
});
client.on("error", (e) => {
  console.error("Error:", e?.message ?? e);
  keluar(1);
});
