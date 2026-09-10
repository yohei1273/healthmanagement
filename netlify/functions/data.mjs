/* 記録の保存先（npoint.io）への読み書き。URLはここに置き、ブラウザには出さない。
   これで、サイトのURLを知られても合言葉なしでは中身が見えない。

   必要な環境変数:
     NPOINT_URL   https://api.npoint.io/xxxxxxxx
     APP_TOKEN    端末で入力する合言葉

   GET  /data?t=合言葉   → 保存されているJSONを返す
   POST /data?t=合言葉   → 丸ごと上書き */

const CORS = {"Access-Control-Allow-Origin":"*", "Content-Type":"application/json"};
const ok  = o => new Response(JSON.stringify(o), {headers:CORS});
const bad = (m,s=400) => new Response(JSON.stringify({error:m}), {status:s, headers:CORS});

export default async (req) => {
  if(req.method === "OPTIONS") return new Response("", {headers:{...CORS,
    "Access-Control-Allow-Headers":"Content-Type", "Access-Control-Allow-Methods":"GET,POST"}});

  const store = process.env.NPOINT_URL;
  if(!store) return bad("NPOINT_URL が未設定です");

  const url = new URL(req.url);
  if(process.env.APP_TOKEN && url.searchParams.get("t") !== process.env.APP_TOKEN)
    return bad("合言葉が違います", 401);

  try{
    if(req.method === "GET"){
      const r = await fetch(store, {cache:"no-store"});
      if(!r.ok) throw new Error(`npoint ${r.status}`);
      const j = await r.json();
      return ok({records: Array.isArray(j.records) ? j.records : [],
                 routes:  Array.isArray(j.routes)  ? j.routes  : [],
                 settings: j.settings || {},
                 today: j.today || null});
    }
    if(req.method === "POST"){
      const body = await req.json();
      if(!body || !Array.isArray(body.records))
        return bad("records が配列ではありません");   // 空データでの上書き事故を防ぐ
      const r = await fetch(store, {method:"POST",
        headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
      if(!r.ok) throw new Error(`npoint ${r.status}`);
      return ok({saved:true, records:body.records.length, routes:(body.routes||[]).length});
    }
    return bad("GET か POST を使ってください", 405);
  }catch(e){ return bad(e.message, 502); }
};
