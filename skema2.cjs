const fs = require("fs");
const cp = require("child_process");
const f = cp.execSync('find node_modules -path "*bedrock/1.26.40/protocol.json" | head -1').toString().trim();
const t = JSON.parse(fs.readFileSync(f)).types;
const nama = Object.keys(t).filter((k) => /input/i.test(k));
console.log("tipe berawalan Input:", nama.join(", "));
for (const k of nama) {
  console.log("---", k);
  console.log(JSON.stringify(t[k]).slice(0, 2500));
}
