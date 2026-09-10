/* 滝ノ水中央公園を起終点に周回ルートを1本作る。
   ORSのキーはここに置く。ブラウザには出さない（HeiGITの規約が推奨する形）。

   必要な環境変数:
     ORS_API_KEY   account.heigit.org で発行したキー（eyJ... で始まる）
   任意:
     START_LAT / START_LNG   既定は滝ノ水中央公園

   GET /route?km=5&n=8&dir=南&avoid=10,95

   ORSのround_tripはseedで大まかな方角が変わるが、どのseedがどっちを向くかは
   叩いてみないと分からない。なので多めに投げて、返ってきた線の重心が起点から
   見てどの方角にあるかを実際に測り、その中から選ぶ。
     dir   … その方角に近いものを選ぶ（北/北東/東/南東/南/南西/西/北西 か 0-359）
     avoid … 直近に走った方角。そこから一番離れたものを選ぶ */

const ORS = "https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson";

const CORS = {"Access-Control-Allow-Origin":"*", "Content-Type":"application/json"};
const ok  = o => new Response(JSON.stringify(o), {headers:CORS});
const bad = (m,s=400) => new Response(JSON.stringify({error:m}), {status:s, headers:CORS});

const COMPASS = ["北","北東","東","南東","南","南西","西","北西"];
const nameOf = b => COMPASS[Math.round(((b%360)+360)%360 / 45) % 8];
const toBearing = v => {
  if(v == null || v === "") return null;
  const i = COMPASS.indexOf(String(v).trim());
  if(i >= 0) return i*45;
  const n = Number(v);
  return Number.isFinite(n) ? ((n%360)+360)%360 : null;
};
/* 2つの方位の差を0〜180で返す */
const gap = (a,b) => { const d = Math.abs(a-b) % 360; return d > 180 ? 360-d : d; };

function bearingTo(lat1, lng1, lat2, lng2){
  const r = Math.PI/180;
  const y = Math.sin((lng2-lng1)*r) * Math.cos(lat2*r);
  const x = Math.cos(lat1*r)*Math.sin(lat2*r)
          - Math.sin(lat1*r)*Math.cos(lat2*r)*Math.cos((lng2-lng1)*r);
  return ((Math.atan2(y,x)/r) + 360) % 360;
}

async function attempt(key, lat, lng, meters, seed){
  const body = {coordinates:[[lng,lat]], elevation:true, instructions:false,
                options:{round_trip:{length:meters, points:5, seed}}};
  const send = b => fetch(ORS, {method:"POST",
    headers:{Authorization:key, "Content-Type":"application/json",
             Accept:"application/geo+json"},
    body:JSON.stringify(b)});
  let res = await send(body);
  if(res.status === 400){                    // 一部バージョンはハイフン表記
    res = await send({...body, options:{"round-trip":body.options.round_trip}});
  }
  if(!res.ok) throw new Error(`ORS ${res.status}`);
  const f = (await res.json()).features[0];
  const c = f.geometry.coordinates;
  // 線の重心＝コースがどちらに張り出しているか
  const cx = c.reduce((s,p)=>s+p[0],0)/c.length;
  const cy = c.reduce((s,p)=>s+p[1],0)/c.length;
  return {seed, dist:f.properties.summary.distance,
          ascent:f.properties.ascent ?? 0, descent:f.properties.descent ?? 0,
          bearing:Math.round(bearingTo(lat, lng, cy, cx)), coords:c};
}

export default async (req) => {
  const key = process.env.ORS_API_KEY;
  if(!key) return bad("ORS_API_KEY が未設定です");

  const url = new URL(req.url);
  const km  = Number(url.searchParams.get("km") || 5);
  const n   = Math.min(Number(url.searchParams.get("n") || 8), 12);
  const tol = Number(url.searchParams.get("tol") || 0.03);
  if(!(km >= 1 && km <= 30)) return bad("km は 1〜30 で指定してください");

  const want  = toBearing(url.searchParams.get("dir"));
  const avoid = (url.searchParams.get("avoid") || "").split(",")
                  .map(toBearing).filter(v => v != null);

  const lat = Number(process.env.START_LAT || 35.0839);
  const lng = Number(process.env.START_LNG || 136.9736);

  // 直列だと関数のタイムアウトに当たるのでまとめて投げる
  const base = Date.now() % 100000;
  const tries = await Promise.allSettled(
    Array.from({length:n}, (_,i) => attempt(key, lat, lng, km*1000, base + i*37))
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

  // 距離が合格したものの中から方角で選ぶ
  fit.sort((a,b) => {
    if(want != null) return gap(a.bearing,want) - gap(b.bearing,want) || a.err - b.err;
    if(avoid.length){
      const sep = r => Math.min(...avoid.map(v => gap(r.bearing, v)));
      return sep(b) - sep(a) || a.err - b.err;   // 直近から一番離れた方角
    }
    return a.err - b.err;
  });
  const best = fit[0];

  return ok({
    target: km,
    km: Number((best.dist/1000).toFixed(2)),
    errPct: Number((best.err*100).toFixed(1)),
    ascent: Math.round(best.ascent),
    descent: Math.round(best.descent),
    bearing: best.bearing,
    dir: nameOf(best.bearing),
    coords: best.coords,
    tried: n,
    kept: fit.length,
    dirs: [...new Set(fit.map(r => nameOf(r.bearing)))]
  });
};
