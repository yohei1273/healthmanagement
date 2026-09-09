/* iPhoneのショートカットからランのデータを受け取り、npoint.io の記録に差し込む。
   ヘルスケアの生データ（距離・消費カロリー・開始終了時刻）だけ送ってもらい、
   時間とペースの計算はここでやる。ショートカット側を単純に保つため。

   必要な環境変数:
     APP_TOKEN   ショートカットと共有する合言葉
     NPOINT_URL  記録の保存先（例 https://api.npoint.io/xxxxxxxx）

   POST body 例:
   {"token":"...","date":"2026-09-11","distKm":5.02,
    "kcal":320,"startISO":"2026-09-11T06:05:12+09:00",
    "endISO":"2026-09-11T06:34:50+09:00"} */

const CORS = {"Access-Control-Allow-Origin":"*", "Content-Type":"application/json"};
const ok  = o => new Response(JSON.stringify(o), {headers:CORS});
const bad = (m,s=400) => new Response(JSON.stringify({error:m}), {status:s, headers:CORS});

const hms = s => `${Math.floor(s/60)}:${String(Math.round(s%60)).padStart(2,"0")}`;
const paceOf = (sec, km) => {
  if(!sec || !km) return undefined;
  const p = Math.round(sec/km);
  return `${Math.floor(p/60)}'${String(p%60).padStart(2,"0")}"`;
};

export default async (req) => {
  if(req.method === "OPTIONS") return new Response("", {headers:CORS});
  if(req.method !== "POST") return bad("POSTしてください", 405);

  const npoint = process.env.NPOINT_URL;
  if(!npoint) return bad("NPOINT_URL が未設定です");

  let body;
  try{ body = await req.json(); }catch{ return bad("JSONを解釈できません"); }
  if(process.env.APP_TOKEN && body.token !== process.env.APP_TOKEN)
    return bad("unauthorized", 401);

  const km = Number(body.distKm);
  if(!km || km < 0.3) return ok({skipped:true, reason:"距離が短いので記録しません", distKm:km||0});

  let sec;
  if(body.startISO && body.endISO)
    sec = Math.round((new Date(body.endISO) - new Date(body.startISO))/1000);

  const rec = {
    date: body.date || new Date().toISOString().slice(0,10),
    type: "外ラン",
    dist: Number(km.toFixed(2)),
    time: sec ? hms(sec) : undefined,
    pace: paceOf(sec, km),
    kcal: body.kcal ? Math.round(Number(body.kcal)) : undefined
  };
  for(const k of Object.keys(rec)) if(rec[k] === undefined) delete rec[k];

  try{
    const r = await fetch(npoint, {cache:"no-store"});
    const db = r.ok ? await r.json() : {};
    db.records = Array.isArray(db.records) ? db.records : [];
    db.routes  = Array.isArray(db.routes)  ? db.routes  : [];

    // 同じ日の行があれば、既にある値（体組成やきつさ）は消さずに上書きする
    const i = db.records.findIndex(x => x.date === rec.date);
    if(i >= 0) db.records[i] = Object.assign({}, db.records[i], rec);
    else db.records.push(rec);
    db.records.sort((a,b) => a.date.localeCompare(b.date));

    const w = await fetch(npoint, {method:"POST",
      headers:{"Content-Type":"application/json"}, body:JSON.stringify(db)});
    if(!w.ok) throw new Error(`npoint ${w.status}`);
    return ok({saved:true, record:rec});
  }catch(e){ return bad(e.message, 502); }
};
