/* 毎朝6時（JST）に、その日のメニューとルートを決めて npoint に書き込む。
   サイトを開いたときには決まっているので、待ち時間もAPI呼び出しも発生しない。

   Netlify の定期実行は UTC 指定なので 21:00 UTC = 翌 06:00 JST。

   必要な環境変数:
     ANTHROPIC_API_KEY / NPOINT_URL / APP_TOKEN / ORS_API_KEY
     URL は Netlify が自動で入れる（自サイトの /route を呼ぶのに使う）

   手動でも叩ける: GET /morning?t=合言葉&force=1 */

const CORS = {"Access-Control-Allow-Origin":"*", "Content-Type":"application/json"};
const ok  = o => new Response(JSON.stringify(o), {headers:CORS});
const bad = (m,s=400) => new Response(JSON.stringify({error:m}), {status:s, headers:CORS});

const START = [35.0839, 136.9736];
const WX = {0:"快晴",1:"晴れ",2:"薄曇り",3:"曇り",45:"霧",48:"霧",51:"霧雨",53:"霧雨",55:"霧雨",
  61:"小雨",63:"雨",65:"強い雨",66:"氷雨",67:"氷雨",71:"雪",73:"雪",75:"大雪",77:"霧雪",
  80:"にわか雨",81:"にわか雨",82:"激しいにわか雨",85:"にわか雪",86:"にわか雪",
  95:"雷雨",96:"雷雨（雹）",99:"激しい雷雨"};

const jstDate = (ms = Date.now()) => new Date(ms + 9*3600e3).toISOString().slice(0,10);
const daysAgo = (date, today) =>
  Math.round((new Date(today+"T12:00:00") - new Date(date+"T12:00:00"))/864e5);
const labelOf = n => n===0 ? "今日" : n===1 ? "昨日" : n===2 ? "一昨日" : `${n}日前`;

const PROMPT = `あなたは名古屋市緑区に住む20代男性のランニングコーチ兼トレーナーです。
彼は毎朝、滝ノ水中央公園を起終点に走るか、天候が悪ければ室内で自重トレをします。
目的は減量で、目標体重に向けて脂肪を落としつつ筋肉は保ちたい。

各記録には「いつ」が付いています。日付から自分で何日前かを計算せず、
必ずその表記に従ってください。「今日」と書かれた記録は今日のことです。

「今日すでに実施した内容」に記録がある場合、彼はもう今日の運動を終えています。
その場合は新しいメニューを出さず、mode はやった内容をそのまま入れ、
reason ではその日の走りを踏まえた言葉をかけ、stretchPre は空配列にしてください。

以下のデータを読んで、今日やるべきことを決めてください。
機械的な計算式ではなく、記録の流れ・きつさの言葉・天気・目標への進み具合を
総合的に見て、今日の彼にとって一番いい判断をしてください。
数字を少し変えるだけの無難な提案より、必要なら強度を大きく落とす、
必要なら上げる、といった判断をしてください。

彼は毎日必ず何かをやります。完全な休養日は作りません。
疲労が強い日や故障が心配な日は "回復" を選び、散歩・軽い体操・
ストレッチ中心の、負荷はほぼゼロだが体は動かす内容にしてください。
「今日は休んでください」で終わらせず、必ず具体的なメニューを出すこと。

出力は次のJSONのみ。前置き・説明・コードフェンスは不要です。

{
 "mode": "外ラン" | "室内トレ" | "回復",
 "km": 数値またはnull,
 "direction": "北"|"北東"|"東"|"南東"|"南"|"南西"|"西"|"北西"|null,
 "shape": "周回"|"往復"|null,
 "headline": "今朝の一言。15文字以内",
 "reason": "その判断の理由。彼に語りかける調子で2〜3文",
 "stretchPre": [["種目名","回数や秒数"], ...],
 "stretchPost": [["種目名","回数や秒数"], ...],
 "indoor": [["種目名","回数×セット"], ...],
 "note": "今日気をつけること、または減量の進み具合について1〜2文"
}

規則:
- modeが外ランならkmを入れ、indoorは空配列にする。
- modeが室内トレまたは回復ならkmはnull、indoorを埋める。
- 「今朝のやりとり」に彼の言葉があれば最優先で反映する。時間がない・坂を走りたい・
  膝が痛い・遠くまで行きたい等、内容に応じて距離も方角もメニューも変える。
  ただし痛みや不調の訴えには無理をさせない方向で応じる。
- shapeはコースの形。迷いたくない日やペースを一定に保ちたい日は "往復"、
  景色を変えたい日は "周回"。こだわりがなければ null。
- directionは今日どちら方面へ走るか。直近数日の「走った方角」を見て、
  同じ方面が続かないように変える。こだわりがなければ null。
- stretchPreは動的ストレッチのみ。走る直前の静的ストレッチは筋出力を下げるので入れない。
- stretchPostは静的ストレッチ。前回のきつさや筋肉痛の記述に応じて内容を変える。
- 回復の日のindoorは、散歩20分・ラジオ体操・可動域ドリルのような軽いもので埋める。
- 体重の増減だけでなく、体脂肪率と筋肉量の動きを見て判断する。`;

async function weather(){
  try{
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${START[0]}`
      + `&longitude=${START[1]}&current=temperature_2m,apparent_temperature,precipitation,`
      + `weather_code,wind_speed_10m&timezone=Asia%2FTokyo`);
    const c = (await r.json()).current;
    return {気温:c.temperature_2m, 体感:c.apparent_temperature, 天気:WX[c.weather_code]||"不明",
            降水mm:c.precipitation, 風速:c.wind_speed_10m,
            雷:[95,96,99].includes(c.weather_code), code:c.weather_code};
  }catch{ return "取得できず"; }
}

export default async (req) => {
  const store = process.env.NPOINT_URL, key = process.env.ANTHROPIC_API_KEY;
  if(!store || !key) return bad("NPOINT_URL / ANTHROPIC_API_KEY が未設定です");

  const url = new URL(req.url);
  const scheduled = !url.searchParams.has("t");       // 定期実行には合言葉が付かない
  if(!scheduled && process.env.APP_TOKEN
     && url.searchParams.get("t") !== process.env.APP_TOKEN)
    return bad("合言葉が違います", 401);

  const today = jstDate();

  try{
    const db = await (await fetch(store, {cache:"no-store"})).json();
    db.records = Array.isArray(db.records) ? db.records : [];
    db.routes  = Array.isArray(db.routes)  ? db.routes  : [];
    const t = (db.today && db.today.date === today)
      ? db.today : {date:today, brief:null, route:null, chat:[]};

    if(t.brief && !url.searchParams.has("force"))
      return ok({skipped:true, reason:"今日の指示はもう決まっています", date:today});

    const done = db.records.find(r => r.date === today && (r.dist || r.type)) || null;
    const said = (t.chat||[]).filter(m => m.role === "user").map(m => m.content);
    const dist = db.records.reduce((s,r)=>s+(r.dist||0), 0);

    const ctx = {
      今日: today,
      今朝のやりとり: said.length ? said : "なし",
      今日すでに実施した内容: done ? {内容:done.type, 距離:done.dist, 時間:done.time,
        ペース:done.pace, きつさ:done.hard, メモ:done.memo} : "まだ何もしていない",
      積み上げ: {通算距離:Number(dist.toFixed(1)), 記録数:db.records.length},
      目標体重: (db.settings && db.settings.goalW) || 60,
      現在の天気: await weather(),
      直近の記録: db.records.slice(-21).map(r => ({
        いつ: labelOf(daysAgo(r.date, today)), 日付:r.date, 内容:r.type,
        体重:r.w, 体脂肪率:r.fat, 距離:r.dist, 時間:r.time, ペース:r.pace,
        高低差:r.elev, きつさ:r.hard, メモ:r.memo, 走った方角:r.dir
      }))
    };

    const ai = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json", "x-api-key":key,
               "anthropic-version":"2023-06-01"},
      body: JSON.stringify({model:"claude-sonnet-4-6", max_tokens:1500,
        messages:[{role:"user", content: PROMPT + "\n\n" + JSON.stringify(ctx, null, 1)}]})
    });
    if(!ai.ok) return bad(`Anthropic ${ai.status}`, 502);
    const j = await ai.json();
    const txt = j.content.filter(b=>b.type==="text").map(b=>b.text).join("")
                 .replace(/```json|```/g,"").trim();
    const brief = JSON.parse(txt);

    // 外ランならルートも先に用意しておく
    let route = null;
    if(!done && brief.mode === "外ラン" && brief.km){
      try{
        const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
        const p = new URLSearchParams({km:String(brief.km), n:"8",
          shape: brief.shape === "往復" ? "outback" : "loop",
          t: process.env.APP_TOKEN || ""});
        if(brief.direction) p.set("dir", brief.direction);
        const avoid = db.records.filter(r=>r.dir).slice(-3).map(r=>r.dir);
        if(avoid.length) p.set("avoid", avoid.join(","));
        const rr = await fetch(`${base}/.netlify/functions/route?${p}`);
        if(rr.ok){
          const r = await rr.json();
          route = {id: Math.random().toString(36).slice(2,9),
            name:`${brief.km}km ${r.dir}へ${r.shape}`, target:r.target, km:r.km,
            ascent:r.ascent, descent:r.descent, bearing:r.bearing, dir:r.dir,
            shape:r.shape, turnKm:r.turnKm, coords:r.coords,
            created:today, used:0, errPct:r.errPct};
        }
      }catch{}     // ルートが作れなくても指示は保存する。画面側で作り直せる
    }

    db.today = {date:today, brief, route, chat:t.chat || []};
    const w = await fetch(store, {method:"POST",
      headers:{"Content-Type":"application/json"}, body:JSON.stringify(db)});
    if(!w.ok) return bad(`npoint ${w.status}`, 502);

    return ok({date:today, brief, route, hasRoute: !!route});
  }catch(e){ return bad(e.message, 502); }
};

/* 21:00 UTC = 06:00 JST */
export const config = { schedule: "0 21 * * *" };
