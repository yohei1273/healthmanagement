/* 滝ノ水中央公園を起終点にコースを1本作る。
   ORSのキーはここに置く。ブラウザには出さない（HeiGITの規約が推奨する形）。

   必要な環境変数:
     ORS_API_KEY   account.heigit.org で発行したキー（eyJ... で始まる）
   任意:
     START_LAT / START_LNG   既定は滝ノ水中央公園

   GET /route?km=5&shape=loop&dir=南&avoid=10,95&n=8

     shape … loop（周回）か outback（往復）。既定 loop
     km    … 目標距離
     tol   … 許容誤差。既定 0.05（±5%）
     dir   … 方角（北/北東/東/南東/南/南西/西/北西 か 0-359）
     avoid … 直近に走った方角。そこから一番離れたものを選ぶ
     pts   … 周回の経由地数。既定 3。増やすほど道が複雑になる

   周回は経由地をランダムに置いて繋ぐ仕組みなので、経由地が多いと
   住宅街の細道を行ったり来たりする線になりやすい。既定を3に下げたうえで、
   進行方向の変化量を測って「曲がりの少ないもの」を優先する。 */

const ORS = "https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson";

const CORS = {"Access-Control-Allow-Origin":"*", "Content-Type":"application/json"};
const ok  = o => new Response(JSON.stringify(o), {headers:CORS});
const bad = (m,s=400) => new Response(JSON.stringify({error:m}), {status:s, headers:CORS});

const COMPASS = ["北","北東","東","南東","南","南西","西","北西"];
const R_EARTH = 6371000;
const rad = d => d*Math.PI/180, deg = r => r*180/Math.PI;

const nameOf = b => COMPASS[Math.round(((b%360)+360)%360 / 45) % 8];
const toBearing = v => {
  if(v == null || v === "") return null;
  const i = COMPASS.indexOf(String(v).trim());
  if(i >= 0) return i*45;
  const n = Number(v);
  return Number.isFinite(n) ? ((n%360)+360)%360 : null;
};
const gap = (a,b) => { const d = Math.abs(a-b) % 360; return d > 180 ? 360-d : d; };

function bearingTo(lat1, lng1, lat2, lng2){
  const y = Math.sin(rad(lng2-lng1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1))*Math.sin(rad(lat2))
          - Math.sin(rad(lat1))*Math.cos(rad(lat2))*Math.cos(rad(lng2-lng1));
  return (deg(Math.atan2(y,x)) + 360) % 360;
}
/* 起点から方位bearingへd(m)進んだ地点 */
function destPoint(lat, lng, bearing, d){
  const ad = d/R_EARTH, br = rad(bearing), la = rad(lat), lo = rad(lng);
  const la2 = Math.asin(Math.sin(la)*Math.cos(ad) + Math.cos(la)*Math.sin(ad)*Math.cos(br));
  const lo2 = lo + Math.atan2(Math.sin(br)*Math.sin(ad)*Math.cos(la),
                              Math.cos(ad) - Math.sin(la)*Math.sin(la2));
  return [deg(lo2), deg(la2)];
}

/* 進行方向がどれだけ変わったかの合計。小さいほど素直な道。
   細かいギザギザに引っ張られないよう、約40mごとに間引いて測る。 */
function wiggleOf(coords){
  const pts = [];
  let last = null;
  for(const c of coords){
    if(!last){ pts.push(c); last = c; continue; }
    const dx = (c[0]-last[0])*Math.cos(rad(c[1]))*111320;
    const dy = (c[1]-last[1])*110540;
    if(Math.hypot(dx,dy) >= 40){ pts.push(c); last = c; }
  }
  if(pts.length < 3) return 0;
  let sum = 0;
  for(let i=1; i<pts.length-1; i++){
    const b1 = bearingTo(pts[i-1][1], pts[i-1][0], pts[i][1], pts[i][0]);
    const b2 = bearingTo(pts[i][1], pts[i][0], pts[i+1][1], pts[i+1][0]);
    const t = gap(b1,b2);
    if(t > 25) sum += t;                 // ゆるいカーブは曲がりとみなさない
  }
  return Math.round(sum);
}

function summarize(f, lat, lng){
  const c = f.geometry.coordinates;
  const cx = c.reduce((s,p)=>s+p[0],0)/c.length;
  const cy = c.reduce((s,p)=>s+p[1],0)/c.length;
  return {dist:f.properties.summary.distance,
          ascent:f.properties.ascent ?? 0, descent:f.properties.descent ?? 0,
          bearing:Math.round(bearingTo(lat, lng, cy, cx)),
          wiggle:wiggleOf(c), coords:c};
}

async function post(key, body){
  const send = b => fetch(ORS, {method:"POST",
    headers:{Authorization:key, "Content-Type":"application/json",
             Accept:"application/geo+json"},
    body:JSON.stringify(b)});
  let res = await send(body);
  if(res.status === 400 && body.options && body.options.round_trip){
    res = await send({...body, options:{"round-trip":body.options.round_trip}});
  }
  if(!res.ok) throw new Error(`ORS ${res.status}`);
  return (await res.json()).features[0];
}

/* 周回：seedごとに1本 */
async function loopTry(key, lat, lng, meters, seed, pts){
  const f = await post(key, {coordinates:[[lng,lat]], elevation:true, instructions:false,
    options:{round_trip:{length:meters, points:pts, seed}}});
  return {seed, ...summarize(f, lat, lng)};
}

/* 往復：目標の半分だけ先へ行って引き返す。
   道のりは直線距離より長いので、実測を見て折返し地点を詰め直す。 */
async function outBack(key, lat, lng, meters, bearing, tol, budgetMs){
  const t0 = Date.now();
  let factor = 1.3, best = null;
  for(let i=0; i<3; i++){
    // 関数のタイムアウトに当たる前に切り上げる。1本でも作れていればそれを返す
    if(i > 0 && best && Date.now() - t0 > budgetMs) break;
    const dest = destPoint(lat, lng, bearing, (meters/2)/factor);
    const f = await post(key, {coordinates:[[lng,lat], dest],
      elevation:true, instructions:false});
    const one = summarize(f, lat, lng);
    const total = one.dist*2;
    const back = one.coords.slice(0,-1).reverse();
    best = {dist: total, ascent: one.ascent + one.descent,
            descent: one.ascent + one.descent,
            bearing: Math.round(bearingTo(lat, lng,
              one.coords[one.coords.length-1][1], one.coords[one.coords.length-1][0])),
            wiggle: one.wiggle*2, coords: one.coords.concat(back), turn: one.dist};
    const err = Math.abs(total - meters)/meters;
    if(err <= tol) break;
    factor = factor * (total/meters);          // 実測から補正して次の試行へ
  }
  return best;
}

export default async (req) => {
  const key = process.env.ORS_API_KEY;
  if(!key) return bad("ORS_API_KEY が未設定です");

  const url = new URL(req.url);
  if(process.env.APP_TOKEN && url.searchParams.get("t") !== process.env.APP_TOKEN)
    return bad("合言葉が違います", 401);

  const km    = Number(url.searchParams.get("km") || 5);
  const n     = Math.min(Number(url.searchParams.get("n") || 8), 12);
  const tol   = Number(url.searchParams.get("tol") || 0.05);
  const pts   = Math.max(2, Math.min(Number(url.searchParams.get("pts") || 3), 8));
  const shape = (url.searchParams.get("shape") || "loop").toLowerCase();
  if(!(km >= 1 && km <= 30)) return bad("km は 1〜30 で指定してください");

  const want  = toBearing(url.searchParams.get("dir"));
  const avoid = (url.searchParams.get("avoid") || "").split(",")
                  .map(toBearing).filter(v => v != null);

  const lat = Number(process.env.START_LAT || 35.0839);
  const lng = Number(process.env.START_LNG || 136.9736);

  /* ---- 往復 ---- */
  if(shape === "outback"){
    // 方角の指定がなければ、直近から一番離れた方角を自分で決める
    let b = want;
    if(b == null){
      const cand = [0,45,90,135,180,225,270,315];
      b = avoid.length
        ? cand.sort((p,q)=>Math.min(...avoid.map(v=>gap(q,v))) - Math.min(...avoid.map(v=>gap(p,v))))[0]
        : cand[Math.floor(Math.random()*8)];
    }
    try{
      const r = await outBack(key, lat, lng, km*1000, b, tol, 5000);
      const err = Math.abs(r.dist/1000 - km)/km;
      if(err > Math.max(tol, 0.12))
        return bad(`目標 ${km}km に対して誤差 ${(err*100).toFixed(1)}% までしか寄せられませんでした`, 422);
      return ok({shape:"往復", target:km, km:Number((r.dist/1000).toFixed(2)),
        errPct:Number((err*100).toFixed(1)), ascent:Math.round(r.ascent),
        descent:Math.round(r.descent), bearing:r.bearing, dir:nameOf(r.bearing),
        wiggle:r.wiggle, turnKm:Number((r.turn/1000).toFixed(2)), coords:r.coords});
    }catch(e){ return bad(e.message, 502); }
  }

  /* ---- 周回 ---- */
  const base = Date.now() % 100000;
  const tries = await Promise.allSettled(
    Array.from({length:n}, (_,i) => loopTry(key, lat, lng, km*1000, base + i*37, pts))
  );
  const got = tries.filter(t => t.status === "fulfilled").map(t => t.value);
  if(!got.length){
    const why = tries.find(t => t.status === "rejected");
    return bad(why ? why.reason.message : "ルートを生成できませんでした", 502);
  }

  const scored = got.map(r => ({...r, err: Math.abs(r.dist/1000 - km) / km}));
  const fit = scored.filter(r => r.err <= tol);
  if(!fit.length){
    const near = scored.sort((a,b)=>a.err-b.err)[0];
    return bad(`目標 ${km}km に対して誤差 ${(near.err*100).toFixed(1)}% までしか寄せられませんでした`, 422);
  }

  /* 方角が合うものに絞ってから、その中で一番曲がりの少ないものを選ぶ */
  let pool = fit;
  if(want != null){
    const best = Math.min(...fit.map(r => gap(r.bearing, want)));
    pool = fit.filter(r => gap(r.bearing, want) <= best + 25);
  }else if(avoid.length){
    const sep = r => Math.min(...avoid.map(v => gap(r.bearing, v)));
    const best = Math.max(...fit.map(sep));
    pool = fit.filter(r => sep(r) >= best - 25);
  }
  pool.sort((a,b) => a.wiggle - b.wiggle || a.err - b.err);
  const best = pool[0];

  return ok({
    shape: "周回", target: km,
    km: Number((best.dist/1000).toFixed(2)),
    errPct: Number((best.err*100).toFixed(1)),
    ascent: Math.round(best.ascent), descent: Math.round(best.descent),
    bearing: best.bearing, dir: nameOf(best.bearing),
    wiggle: best.wiggle, pts,
    coords: best.coords,
    tried: n, kept: fit.length,
    wiggles: pool.map(r => r.wiggle)
  });
};
