import bedrock from "bedrock-protocol";
import fs from "node:fs";

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
const GERAK_MATI = process.env.GERAK !== "1" || fs.existsSync("gagal-gerak.flag");
let waktuSpawn = 0;
let paketTerkirim = 0;
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

const BIT = {
  jump_down: 3,
  jumping: 6,
  up: 10,
  down: 11,
  start_jumping: 31,
  jump_pressed_raw: 60,
  jump_current_raw: 61,
};

function bitset(nama) {
  const b = new Array(10).fill(0);
  for (const n of nama) {
    const i = BIT[n];
    if (i === undefined) continue;
    b[Math.floor(i / 7)] |= 1 << (i % 7);
  }
  return Buffer.from(b.map((v, i) => (i < 9 ? v | 0x80 : v)));
}

function varint64(n) {
  const out = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function f32(x) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(x);
  return b;
}

function kirim(flags, mv, delta) {
  tick += 1n;
  const paket = Buffer.concat([
    Buffer.from([0x90, 0x01]),
    f32(0),
    f32(YAW),
    f32(posisi.x),
    f32(posisi.y),
    f32(posisi.z),
    f32(mv.x),
    f32(mv.z),
    f32(YAW),
    bitset(Object.keys(flags).filter((k) => flags[k])),
    Buffer.from([1, 0, 0]),
    f32(0),
    f32(YAW),
    varint64(tick),
    f32(delta.x),
    f32(delta.y),
    f32(delta.z),
    f32(mv.x),
    f32(mv.z),
    f32(0),
    f32(0),
    f32(1),
    f32(mv.x),
    f32(mv.z),
  ]);
  try {
    client.sendBuffer(paket, true);
    galat = 0;
    paketTerkirim++;
    if (paketTerkirim === 1) console.log("Paket gerak pertama terkirim");
  } catch (e) {
    galat++;
    if (galat <= 3) console.error("Gagal kirim gerakan:", e?.message ?? e);
    if (galat >= 6) {
      gerakAktif = false;
      console.error("Gerakan dimatikan karena paket tidak bisa dikirim, bot tetap AFK di server");
    }
  }
}

function langkah() {
  if (!siap || !posisi || !gerakAktif || GERAK_MATI) return;
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
      console.log("Putaran selesai: maju, mundur, lompat");
    }
    delta.y = posisi.y - yLama;
  }
  kirim(flags, mv, delta);
}

function mulaiGerak() {
  if (fase === "diam" && siap && gerakAktif) {
    fase = "maju";
    sisa = LANGKAH;
    console.log("Mulai gerakan: maju");
  }
}

client.on("join", () => console.log("Login diterima server"));

const JOKES = [
  "Kenapa ayam nyebrang jalan? Karena kalau nyebrang laut kejauhan.",
  "Kenapa Creeper nggak punya teman? Karena tiap dekat langsung meledak emosinya.",
  "Kenapa Steve selalu bawa kasur? Biar bisa skip malam.",
  "Kenapa skeleton nggak ke pesta? Soalnya nggak ada yang diajak, no body.",
  "Kenapa Enderman jago petak umpet? Soalnya kalau dilihat langsung marah.",
  "Kenapa pickaxe selalu optimis? Karena selalu lihat sisi diamond.",
  "Apa warna favorit Creeper? Hijau, tapi kalau meledak jadi merah padam.",
  "Kenapa babi di Minecraft nggak pernah diet? Makannya wortel doang tapi tetap bulat.",
  "Kenapa ayam di Minecraft rajin bertelur? Karena nggak ada lembur, kerjaannya cuma itu.",
  "Apa bedanya kamu sama bedrock? Bedrock susah dihancurin, kamu susah dihubungi.",
  "Kenapa torch nggak pernah kesepian? Soalnya selalu jadi pusat perhatian.",
  "Kenapa wither nggak punya hobi? Soalnya semua yang dia sentuh langsung hilang.",
  "Kenapa komputer sering kedinginan? Karena banyak Windows yang kebuka.",
  "Apa persamaan kamu sama WiFi? Sama-sama sering putus pas lagi dibutuhin.",
  "Buah apa yang paling sabar? Jeruk, sudah diperas masih tetap manis.",
  "Kenapa matematika sedih? Karena punya banyak masalah.",
  "Apa bedanya aku sama kalkulator? Kalkulator bisa ngitung, aku cuma bisa ngitung hari ke gajian.",
  "Kenapa listrik padam? Karena dia capek nyala terus.",
  "Kenapa nasi goreng nggak pernah sendirian? Karena selalu ditemenin telur.",
  "Hewan apa yang paling rajin? Semut, kerjanya baris terus.",
  "Apa bedanya HP sama kamu? HP bisa di-charge, kamu butuh tidur.",
  "Kenapa ikan nggak bisa main game? Takut kena jaring.",
  "Kenapa pensil sering dihapus? Karena salahnya banyak tapi tetap mau ditulis lagi.",
  "Kenapa kopi nggak pernah bohong? Karena pahitnya jujur.",
  "Apa bedanya zombie sama aku hari Senin? Zombie masih semangat jalan.",
  "Kenapa lava panas? Karena dia nggak pernah dingin ke siapa-siapa.",
  "Kenapa villager suka bilang hmm? Karena kata-katanya belum dibayar.",
  "Kenapa cermin nggak pernah ketinggalan gosip? Karena dia selalu melihat semuanya.",
  "Apa bedanya kasur sama pacar? Kasur nggak pernah bilang kamu berubah.",
  "Kenapa Alex kuat? Karena rajin makan roti tiap hari.",
];
const CHAT_AKTIF_AWAL = process.env.CHAT === "1" && !fs.existsSync("gagal-chat.flag");
let tasJoke = [];
let chatTerkirim = 0;
let waktuChatPertama = 0;
let galatChat = 0;
let chatAktif = true;

function jokeBerikut() {
  if (!tasJoke.length) tasJoke = [...JOKES].sort(() => Math.random() - 0.5);
  return tasJoke.pop();
}

function kirimJoke() {
  if (!chatAktif) return;
  try {
    client.write("text", {
      type: "chat",
      needs_translation: false,
      source_name: client.profile?.name ?? "",
      xuid: client.profile?.xuid ?? "",
      platform_chat_id: "",
      filtered_message: "",
      message: jokeBerikut(),
    });
    galatChat = 0;
    chatTerkirim++;
    if (chatTerkirim === 1) {
      waktuChatPertama = Date.now();
      console.log("Joke pertama terkirim, selanjutnya tiap 30 detik");
    }
  } catch (e) {
    galatChat++;
    if (galatChat <= 3) console.error("Gagal kirim chat:", e?.message ?? e);
    if (galatChat >= 3) {
      chatAktif = false;
      console.error("Chat dimatikan karena paket tidak bisa dikirim, bot tetap AFK");
    }
  }
}

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
  waktuSpawn = Date.now();
  if (GERAK_MATI && !CHAT_AKTIF_AWAL) console.log("Mode AFK murni: tanpa gerak dan tanpa chat");
  console.log("Posisi awal:", Math.round(posisi.x), Math.round(posisi.y), Math.round(posisi.z), "gerakan", GERAK_MATI ? "MATI" : "aktif");
  siap = true;
  setInterval(langkah, 50);
  if (CHAT_AKTIF_AWAL) {
    setTimeout(() => {
      kirimJoke();
      setInterval(kirimJoke, 30000);
    }, 10000);
  }
  setTimeout(() => {
    mulaiGerak();
    setInterval(mulaiGerak, JEDA_MS);
  }, 60000);
});

client.on("kick", (p) => {
  console.error("Dikeluarkan dari server:", JSON.stringify(p).slice(0, 200));
  keluar(/idle|afk|timeout/i.test(JSON.stringify(p)) ? 1 : 4);
});
client.on("close", (alasan) => {
  console.error("Koneksi terputus", alasan ?? "");
  if (chatTerkirim > 0 && waktuChatPertama && Date.now() - waktuChatPertama < 20000 && CHAT_AKTIF_AWAL) {
    try {
      fs.writeFileSync("gagal-chat.flag", "1");
    } catch {}
    console.error("Server memutus koneksi tak lama setelah chat; sesi berikutnya bot AFK tanpa chat");
  }
  if (paketTerkirim > 0 && waktuSpawn && Date.now() - waktuSpawn < 20000 && !GERAK_MATI) {
    try {
      fs.writeFileSync("gagal-gerak.flag", "1");
    } catch {}
    console.error("Server memutus koneksi tak lama setelah paket gerak; sesi berikutnya bot AFK tanpa paket");
  }
  keluar(1);
});
client.on("error", (e) => {
  console.error("Error:", e?.message ?? e);
  keluar(1);
});
