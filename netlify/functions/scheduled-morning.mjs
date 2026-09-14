/* 毎朝6時（JST）に動く定期実行。21:00 UTC = 翌 06:00 JST。

   Netlify では schedule を指定した関数はHTTPから呼べなくなるので、
   判断の中身は brief.mjs（HTTP専用）に置いたまま、ここから順に呼ぶ。
   関数1本あたりの実行時間は10秒だが、定期実行は30秒使えるので、
   「指示を作る」→「ルートを作る」→「ルートを書き戻す」を分けて回せる。

   必要な環境変数: APP_TOKEN / NPOINT_URL（URL は Netlify が自動で入れる） */

const ok  = o => new Response(JSON.stringify(o), {headers:{"Content-Type":"application/json"}});

export default async () => {
  const base  = process.env.URL || process.env.DEPLOY_PRIME_URL;
  const token = process.env.APP_TOKEN || "";
  const store = process.env.NPOINT_URL;
  if(!base || !store) return ok({error:"URL / NPOINT_URL が未設定です"});

  const log = [];
  try{
    // 1. その日の指示を作って npoint に保存させる
    const r1 = await fetch(`${base}/.netlify/functions/brief?t=${token}&force=1`);
    const j1 = await r1.json();
    if(j1.error) return ok({step:"brief", error:j1.error});
    log.push(`指示: ${j1.brief?.mode} ${j1.brief?.km ?? ""}`);

    const brief = j1.brief;
    if(!brief || brief.mode !== "外ラン" || !brief.km)
      return ok({done:true, log, route:false});

    // 2. ルートを作る
    const db = await (await fetch(store, {cache:"no-store"})).json();
    const avoid = (db.records||[]).filter(r=>r.dir).slice(-3).map(r=>r.dir);
    const p = new URLSearchParams({t:token, km:String(brief.km), n:"8",
      shape: brief.shape === "往復" ? "outback" : "loop", roads:"big"});
    if(brief.direction) p.set("dir", brief.direction);
    if(avoid.length) p.set("avoid", avoid.join(","));

    const r2 = await fetch(`${base}/.netlify/functions/route?${p}`);
    const j2 = await r2.json();
    if(j2.error){ log.push(`ルート失敗: ${j2.error}`); return ok({done:true, log, route:false}); }
    log.push(`ルート: ${j2.km}km ${j2.dir} ${j2.shape} 曲がり角${j2.turnCount}`);

    // 3. 作ったルートを今日の分に書き戻す
    const fresh = await (await fetch(store, {cache:"no-store"})).json();
    if(fresh.today){
      fresh.today.route = {
        id: Math.random().toString(36).slice(2,9),
        name: `${brief.km}km ${j2.dir}へ${j2.shape}`,
        target: j2.target, km: j2.km, ascent: j2.ascent, descent: j2.descent,
        bearing: j2.bearing, dir: j2.dir, shape: j2.shape, turnKm: j2.turnKm,
        gmaps: j2.gmaps, gmapsExact: j2.gmapsExact, turnCount: j2.turnCount,
        coords: j2.coords, created: fresh.today.date, used: 0, errPct: j2.errPct
      };
      await fetch(store, {method:"POST",
        headers:{"Content-Type":"application/json"}, body:JSON.stringify(fresh)});
    }
    return ok({done:true, log, route:true});
  }catch(e){ return ok({error:e.message, log}); }
};

/* 21:00 UTC = 06:00 JST */
export const config = { schedule: "0 21 * * *" };
