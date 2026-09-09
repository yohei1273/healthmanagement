/* Strava からランのデータを取ってくる。
   NRC の 設定 > パートナー で Strava を繋いでおくと、以降のランがここに流れてくる。
   （NRC の過去分は同期されない。必要なら Nike にデータ書き出しを申請して手で入れる）

   必要な環境変数:
     STRAVA_CLIENT_ID
     STRAVA_CLIENT_SECRET
     STRAVA_REFRESH_TOKEN
   初回だけ ?action=exchange&code=xxx で refresh_token を取る。
   認可URL: https://www.strava.com/oauth/authorize
            ?client_id=...&response_type=code&redirect_uri=http://localhost
            &approval_prompt=force&scope=activity:read_all */

const TOKEN_URL = "https://www.strava.com/api/v3/oauth/token";
const API = "https://www.strava.com/api/v3";

const CORS = {"Access-Control-Allow-Origin":"*", "Content-Type":"application/json"};
const ok  = o => new Response(JSON.stringify(o), {headers:CORS});
const bad = (m,s=400) => new Response(JSON.stringify({error:m}), {status:s, headers:CORS});

async function token(params){
  const r = await fetch(TOKEN_URL, {method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams(params)});
  const j = await r.json();
  if(!r.ok) throw new Error(`Strava: ${j.message||r.status}`);
  return j;
}
const pace = (sec, m) => {
  if(!sec || !m) return null;
  const s = Math.round(sec/(m/1000));
  return `${Math.floor(s/60)}'${String(s%60).padStart(2,"0")}"`;
};
const hms = s => {
  const h = Math.floor(s/3600), m = Math.floor(s%3600/60), x = s%60;
  return (h?`${h}:${String(m).padStart(2,"0")}`:`${m}`) + `:${String(x).padStart(2,"0")}`;
};

export default async (req) => {
  const url = new URL(req.url);
  const id = process.env.STRAVA_CLIENT_ID, secret = process.env.STRAVA_CLIENT_SECRET;
  if(!id || !secret) return bad("STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET が未設定です");

  if(url.searchParams.get("action") === "exchange"){
    const code = url.searchParams.get("code");
    if(!code) return bad("code がありません");
    try{
      const t = await token({client_id:id, client_secret:secret, code, grant_type:"authorization_code"});
      return ok({refresh_token:t.refresh_token,
        next:"この refresh_token を Netlify の環境変数 STRAVA_REFRESH_TOKEN に入れてください"});
    }catch(e){ return bad(e.message); }
  }

  const refresh = process.env.STRAVA_REFRESH_TOKEN;
  if(!refresh) return bad("STRAVA_REFRESH_TOKEN が未設定です。先に ?action=exchange&code=... を実行してください");

  try{
    const t = await token({client_id:id, client_secret:secret,
      refresh_token:refresh, grant_type:"refresh_token"});
    const auth = {Authorization:`Bearer ${t.access_token}`};

    const from = url.searchParams.get("from") || new Date(Date.now()-30*864e5).toISOString().slice(0,10);
    const to   = url.searchParams.get("to")   || new Date().toISOString().slice(0,10);
    const after  = Math.floor(new Date(from+"T00:00:00+09:00").getTime()/1000);
    const before = Math.floor(new Date(to  +"T23:59:59+09:00").getTime()/1000);

    const r = await fetch(`${API}/athlete/activities?after=${after}&before=${before}&per_page=100`, {headers:auth});
    if(!r.ok) throw new Error(`Strava activities ${r.status}`);
    const acts = (await r.json()).filter(a=>a.type==="Run" || a.sport_type==="Run");

    const records = [];
    for(const a of acts){
      const rec = {
        date: a.start_date_local.slice(0,10),
        dist: Number((a.distance/1000).toFixed(2)),
        time: hms(a.moving_time),
        pace: pace(a.moving_time, a.distance),
        elev: a.total_elevation_gain != null ? Math.round(a.total_elevation_gain) : undefined,
        pitch: a.average_cadence != null ? Math.round(a.average_cadence*2) : undefined,
        stravaId: a.id
      };
      // 消費カロリーは一覧に含まれないので、詳細を1件ずつ引く
      try{
        const d = await fetch(`${API}/activities/${a.id}`, {headers:auth});
        if(d.ok){ const j = await d.json(); if(j.calories) rec.kcal = Math.round(j.calories); }
      }catch{}
      records.push(rec);
    }
    records.sort((a,b)=>a.date.localeCompare(b.date));
    return ok({records, count:records.length});
  }catch(e){ return bad(e.message, 502); }
};
