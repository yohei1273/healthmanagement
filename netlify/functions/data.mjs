/* 記録の保存先（npoint.io）への読み書き。URLはここに置き、ブラウザには出さない。
   これで、サイトのURLを知られても合言葉なしでは中身が見えない。

   必要な環境変数:
     NPOINT_URL   https://api.npoint.io/xxxxxxxx
     APP_TOKEN    端末で入力する合言葉

   GET  /data?t=合言葉          → 保存されているJSONを返す
   POST /data?t=合言葉          → 丸ごと上書き（記録が減る場合は拒否）
   POST /data?t=合言葉&force=1  → 減る場合も上書きする

   npoint には履歴が無いので、上書きのたびに直前の records を backup に控える。 */

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
                 today: j.today || null,
                 backup: j.backup || null});
    }
    if(req.method === "POST"){
      const body = await req.json();
      if(!body || !Array.isArray(body.records))
        return bad("records が配列ではありません");

      /* 記録が減る上書きは事故の可能性が高いので、既定で拒否する。
         画面側が読み込みに失敗したまま保存すると、中身が丸ごと消えるため。
         意図的に減らすとき（削除など）は ?force=1 を付ける。 */
      const cur = await fetch(store, {cache:"no-store"})
        .then(r => r.ok ? r.json() : {}).catch(() => ({}));
      const before = Array.isArray(cur.records) ? cur.records.length : 0;
      const after  = body.records.length;
      if(before > 0 && after < before && url.searchParams.get("force") !== "1")
        return bad(`記録が ${before} 件から ${after} 件に減る保存を止めました。`
          + `読み込みに失敗している可能性があります。`, 409);

      // 直前の状態を同じドキュメント内に控えておく（npointに履歴が無いため）
      body.backup = {at:new Date().toISOString(), records:cur.records || []};

      const r = await fetch(store, {method:"POST",
        headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
      if(!r.ok) throw new Error(`npoint ${r.status}`);
      return ok({saved:true, records:after, routes:(body.routes||[]).length});
    }
    return bad("GET か POST を使ってください", 405);
  }catch(e){ return bad(e.message, 502); }
};
