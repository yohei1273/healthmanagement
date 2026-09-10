/* タニタ Health Planet から体組成を取ってくる。
   クライアントシークレットを表に出さないため、必ずこの関数を通す。

   必要な環境変数:
     HP_CLIENT_ID
     HP_CLIENT_SECRET
     HP_REFRESH_TOKEN
   初回だけ ?action=exchange&code=xxx を叩いて refresh_token を取り、
   Netlify の環境変数に入れてから通常利用に移る。 */

const TOKEN_URL = "https://www.healthplanet.jp/oauth/token";
const DATA_URL  = "https://www.healthplanet.jp/status/innerscan.json";
const REDIRECT  = "https://www.healthplanet.jp/success.html";

/* APIで取れるのは 6021 体重 と 6022 体脂肪率 だけ。
   6023 筋肉量 / 6024 筋肉スコア / 6025,6026 内臓脂肪 / 6027 基礎代謝 /
   6028 体内年齢 / 6029 推定骨量 は 2020/6/29 で連携終了している。
   体組成計の画面には出ていてもAPIには来ないので、それらはスクショから読む。
   将来復活したときのために MAP は残してある。HP_TAGS で上書きも可能。 */
const TAGS = process.env.HP_TAGS || "6021,6022";
const MAP = {6021:"w", 6022:"fat", 6023:"mus", 6024:"ms", 6026:"vis",
             6027:"bmr", 6028:"age", 6029:"bone"};

const CORS = {"Access-Control-Allow-Origin":"*", "Content-Type":"application/json"};
const ok   = o => new Response(JSON.stringify(o), {headers:CORS});
const bad  = (m,s=400) => new Response(JSON.stringify({error:m}), {status:s, headers:CORS});

async function form(url, params){
  const r = await fetch(url, {method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams(params)});
  const t = await r.text();
  let j; try{ j = JSON.parse(t); }catch{ throw new Error(`Health Planet: ${t.slice(0,120)}`); }
  if(!r.ok || j.error) throw new Error(`Health Planet: ${j.error_description||j.error||r.status}`);
  return j;
}

const stamp = (d, end) => d.replace(/-/g,"") + (end?"235959":"000000");

export default async (req) => {
  const url = new URL(req.url);
  if(process.env.APP_TOKEN && url.searchParams.get("t") !== process.env.APP_TOKEN
     && url.searchParams.get("action") !== "exchange")
    return bad("合言葉が違います", 401);

  const id = process.env.HP_CLIENT_ID, secret = process.env.HP_CLIENT_SECRET;
  if(!id || !secret) return bad("HP_CLIENT_ID / HP_CLIENT_SECRET が未設定です");

  // 初回: 認可コードを refresh_token に交換する
  if(url.searchParams.get("action") === "exchange"){
    const code = url.searchParams.get("code");
    if(!code) return bad("code がありません");
    try{
      const t = await form(TOKEN_URL, {client_id:id, client_secret:secret,
        redirect_uri:REDIRECT, code, grant_type:"authorization_code"});
      return ok({refresh_token:t.refresh_token, expires_in:t.expires_in,
        next:"この refresh_token を Netlify の環境変数 HP_REFRESH_TOKEN に入れてください"});
    }catch(e){ return bad(e.message); }
  }

  const refresh = process.env.HP_REFRESH_TOKEN;
  if(!refresh) return bad("HP_REFRESH_TOKEN が未設定です。先に ?action=exchange&code=... を実行してください");

  try{
    const t = await form(TOKEN_URL, {client_id:id, client_secret:secret,
      redirect_uri:REDIRECT, refresh_token:refresh, grant_type:"refresh_token"});
    const token = t.access_token;

    // 関数はUTCで動くので、既定値は日本時間の日付にそろえる
    const jst = ms => new Date(ms + 9*3600e3).toISOString().slice(0,10);
    const from = url.searchParams.get("from") || jst(Date.now() - 30*864e5);
    const to   = url.searchParams.get("to")   || jst(Date.now());

    const raw = await form(DATA_URL, {access_token:token, date:"1",
      from:stamp(from), to:stamp(to,true), tag:TAGS});

    // 同じ日に複数回測っていれば、その日の最後の測定を採用する
    const byDate = {};
    for(const d of (raw.data||[])){
      const key = MAP[d.tag]; if(!key) continue;
      const day = `${d.date.slice(0,4)}-${d.date.slice(4,6)}-${d.date.slice(6,8)}`;
      byDate[day] = byDate[day] || {date:day, _t:{}};
      if(!byDate[day]._t[key] || d.date >= byDate[day]._t[key]){
        byDate[day][key] = Number(d.keydata);
        byDate[day]._t[key] = d.date;
      }
    }
    const height = Number(raw.height);
    const records = Object.values(byDate).map(r=>{
      delete r._t;
      if(height && r.w) r.bmi = Number((r.w/Math.pow(height/100,2)).toFixed(1));
      return r;
    }).sort((a,b)=>a.date.localeCompare(b.date));

    const out = {records, height, count:records.length, tags:TAGS};
    if(t.refresh_token && t.refresh_token !== refresh) out.newRefreshToken = t.refresh_token;
    return ok(out);
  }catch(e){ return bad(e.message, 502); }
};
