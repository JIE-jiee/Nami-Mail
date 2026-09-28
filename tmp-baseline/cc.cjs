const fs = require("fs");
const path = require("path");
const all = (d, ext, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) all(p, ext, out);
    else if (ext.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
};
const re = /(?:^|[\s;])(?:import|export)\s+(type\s+)?[^;]*?from\s+["'](\.[^"']+)["']/g;
function run(root, ext) {
  const files = all(root, ext);
  const g = new Map();
  for (const f of files) {
    const deps = new Set();
    let m;
    const src = fs.readFileSync(f, "utf8");
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      if (m[1]) continue;
      let t = path.resolve(path.dirname(f), m[2]);
      const c = [t, t + ".ts", t + ".tsx", t + ".mts", t + ".js", t.replace(/\.(js|ts)$/, "") + ".ts"];
      t = c.find((x) => fs.existsSync(x) && fs.statSync(x).isFile()) || t;
      deps.add(t);
    }
    g.set(path.resolve(f), deps);
  }
  let i = 0;
  const ix = new Map(), lo = new Map(), st = [], on = new Map(), scc = [];
  const go = (v) => {
    ix.set(v, i); lo.set(v, i++); st.push(v); on.set(v, 1);
    for (const w of g.get(v) || []) {
      if (!g.has(w)) continue;
      if (!ix.has(w)) { go(w); lo.set(v, Math.min(lo.get(v), lo.get(w))); }
      else if (on.get(w)) lo.set(v, Math.min(lo.get(v), ix.get(w)));
    }
    if (lo.get(v) === ix.get(v)) { const c = []; let w; do { w = st.pop(); on.set(w, 0); c.push(w); } while (w !== v); scc.push(c); }
  };
  for (const v of g.keys()) if (!ix.has(v)) go(v);
  const cyc = scc.filter((c) => c.length > 1);
  console.log(root + " files=" + files.length + " cycles=" + cyc.length);
  cyc.forEach((c) => console.log("  " + c.map((p) => path.relative(process.cwd(), p)).join(" -> ")));
  return cyc.length;
}
let t = 0;
t += run("apps/server/src", [".ts"]);
t += run("apps/web/src", [".ts", ".tsx"]);
t += run("apps/desktop/src", [".mts", ".cts"]);
console.log("TOTAL=" + t);
