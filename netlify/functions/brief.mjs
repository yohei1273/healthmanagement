/* 毎朝6時（JST）に、その日のメニューとルートを決めて npoint に書き込む。
   サイトを開いたときには決まっているので、待ち時間もAPI呼び出しも発生しない。

   この関数はHTTP専用。定期実行は scheduled-morning.mjs が担当する。

   Netlifyでは schedule を指定した関数はHTTPから呼べず403になる。
   さらに、一度スケジュール登録された関数名は設定を外しても登録が残り、
   HTTPを弾き続けることがある。以前 morning.mjs が該当したため、
   名前を brief に変えてある。morning という名前は今後使わないこと。

   必要な環境変数:
     ANTHROPIC_API_KEY / NPOINT_URL / APP_TOKEN / ORS_API_KEY
     URL は Netlify が自動で入れる（自サイトの /route を呼ぶのに使う）

   手動でも叩ける: GET /brief?t=合言葉&force=1
   定期実行は30秒使えるが、手動呼び出しは10秒で切られる。
   手動のときはルート生成を画面側に任せて、指示だけ返す。 */

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

/* 体脂肪量と除脂肪量。減量の主指標なのに毎回モデルに掛け算させるのは筋が悪い。 */
function comp(r){
  if(r == null || r.w == null || r.fat == null) return null;
  const fat = r.w * r.fat / 100;
  return {fat: Number(fat.toFixed(2)), lean: Number((r.w - fat).toFixed(2))};
}
/* 直近の体組成と、7件前との差 */
function trend(records){
  const withComp = records.filter(r => comp(r));
  if(!withComp.length) return "体重と体脂肪率の記録がまだありません";
  const now = comp(withComp[withComp.length-1]);
  const past = comp(withComp.length >= 7 ? withComp[withComp.length-7] : withComp[0]);
  const span = withComp.length >= 7 ? "7回前との差" : `最初の記録（${withComp[0].date}）との差`;
  return {
    体脂肪量kg: now.fat, 除脂肪量kg: now.lean,
    [span]: {体脂肪量: Number((now.fat-past.fat).toFixed(2)),
             除脂肪量: Number((now.lean-past.lean).toFixed(2))}
  };
}

/* 週ごとの距離。故障は「先週までより急に増やしたとき」に出るので、
   伸ばし方が妥当かどうかを見るための材料。 */
function weekly(records, today){
  const end = new Date(today + "T12:00:00");
  const out = [];
  for(let w=0; w<4; w++){
    const hi = new Date(end); hi.setDate(hi.getDate() - w*7);
    const lo = new Date(hi);  lo.setDate(lo.getDate() - 6);
    const km = records.filter(r => {
      const d = new Date(r.date + "T12:00:00");
      return d >= lo && d <= hi;
    }).reduce((a,r) => a + (r.dist||0), 0);
    out.push({[w===0 ? "直近7日" : `${w*7+1}〜${w*7+7}日前`]: Number(km.toFixed(1))});
  }
  return out;
}
/* 前回の外ランから何日空いたか */
function sinceLastRun(records, today){
  const last = [...records].reverse().find(r => r.dist);
  if(!last) return "外ランの記録なし";
  return daysAgo(last.date, today);
}

/* 連続日数はこちらで数えて渡す。
   記録一覧から数えさせると取り違えるので、計算済みの値だけを使わせる。 */
function streakOf(records, today){
  const done = new Set(records.filter(r => r.type && r.type !== "未実施").map(r => r.date));
  const d = new Date(today + "T12:00:00");
  if(!done.has(today)) d.setDate(d.getDate() - 1);
  let n = 0;
  while(done.has(d.toISOString().slice(0,10))){ n++; d.setDate(d.getDate() - 1); }
  return n;
}

const PROMPT = `あなたは名古屋市緑区に住む20代男性のトレーナーです。
彼は毎朝、滝ノ水中央公園を起終点に走るか、天候が悪ければ室内で自重トレをします。
目的は減量で、目標体重に向けて脂肪を落としつつ筋肉は保ちたい。

話し方は敬語。丁寧だが堅苦しくせず、言うべきことは率直に言う。タメ口は使わない。

走る速さは彼の目的ではありません。ペース・タイム・ピッチには触れないこと。
遅くなったことを指摘しない。本人が訊いたときだけ答える。

彼は食事の管理をしていません。食事の記録も取っていないので、
食事内容について具体的に尋ねたり指摘したりしないでください。
走る量だけで体重を大きく動かすのは難しい（7kmでも450kcal程度、
脂肪1kgは7200kcal）という前提は踏まえつつ、
あなたが手を出せるのは運動の中身だけです。そこで最善を尽くしてください。
体重が横ばいでも、体脂肪量が減って除脂肪量が保てていれば前進です。

各記録には「いつ」が付いています。日付から自分で何日前かを計算せず、
必ずその表記に従ってください。「今日」と書かれた記録は今日のことです。

「積み上げ」と「体組成の現状」の数字はこちらで計算済みです。
連続日数・今月の距離・通算距離・体脂肪量・除脂肪量とその増減は、
記録一覧から計算し直さず、必ずその値をそのまま使ってください。
自分で計算すると取り違えます。

体重は水分で1〜2kg動くので、日々の増減では判断しないこと。
見るべきは体脂肪量が減っているか、除脂肪量が保てているかの2点です。

距離を伸ばすかどうかは「週ごとの距離」で判断してください。
週合計が前週の1.1倍を超える伸ばし方は故障が出やすい水準です。
逆に、週合計が頭打ちなら少し伸ばす提案をしてください。
「最長距離」を大きく超える距離を単発で出さないこと。

「これから3時間」の予報も見てください。今は晴れていても、
1時間後に降り出すなら距離を短めにする、先に出るよう促す、といった判断ができます。
日の出前なら暗さにも触れてください。

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
 "note": "今日気をつけること、または体組成の動きについて1〜2文"
}

規則:
- modeが外ランならkmを入れ、indoorは空配列にする。
- modeが室内トレまたは回復ならkmはnull、indoorを埋める。
- 「本人の最新の発言」は指示として扱う。距離・方角・コースの形・内容を
  はっきり指定されたら、その通りにする。「3〜4kmにしよう」と言われたら
  km は 3 か 4 にする。5 にしてはいけない。自分の判断で上書きしない。
  従えない理由があるとき（痛みの訴えがある、天候が危険）は、
  従わない理由を reason で必ず説明する。
- 「今朝のやりとり」は会話の流れ。時間がない・坂を走りたい・膝が痛い等、
  内容に応じて距離も方角もメニューも変える。
  痛みや不調の訴えには無理をさせない方向で応じる。
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
      + `weather_code,wind_speed_10m`
      + `&hourly=temperature_2m,precipitation_probability,weather_code`
      + `&daily=sunrise,sunset&forecast_days=1&timezone=Asia%2FTokyo`);
    const j = await r.json(), c = j.current;
    const now = new Date(Date.now() + 9*3600e3).getUTCHours();
    const h = j.hourly || {};
    // これから3時間の見通し。走り出すかどうかの判断に直結する
    const ahead = [];
    for(let k=0; k<(h.time||[]).length; k++){
      const hh = Number(h.time[k].slice(11,13));
      if(hh >= now && hh <= now+3)
        ahead.push({時刻:`${hh}時`, 気温:h.temperature_2m[k],
                    降水確率:h.precipitation_probability[k],
                    天気:WX[h.weather_code[k]] || "不明"});
    }
    return {気温:c.temperature_2m, 体感:c.apparent_temperature, 天気:WX[c.weather_code]||"不明",
            降水mm:c.precipitation, 風速:c.wind_speed_10m,
            雷:[95,96,99].includes(c.weather_code), code:c.weather_code,
            これから3時間:ahead,
            日の出:(j.daily?.sunrise?.[0] || "").slice(11),
            日の入り:(j.daily?.sunset?.[0] || "").slice(11)};
  }catch{ return "取得できず"; }
}

export default async (req) => {
  const store = process.env.NPOINT_URL, key = process.env.ANTHROPIC_API_KEY;
  if(!store || !key) return bad("NPOINT_URL / ANTHROPIC_API_KEY が未設定です");

  const url = new URL(req.url);
  if(process.env.APP_TOKEN && url.searchParams.get("t") !== process.env.APP_TOKEN)
    return bad("合言葉が違います", 401);

  /* 会話はリクエストに載せてもらう。npointから読み直すと、保存の遅れや
     日付のずれで丸ごと落ちることがある（実際に落ちていた）。 */
  let sent = null;
  if(req.method === "POST"){
    try{ sent = (await req.json()).chat; }catch{}
  }
  // ルート生成まで入れると10秒に収まらない。既定では指示だけ返す。
  const scheduled = url.searchParams.get("route") === "1";

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
    const talk = Array.isArray(sent) && sent.length ? sent : (t.chat || []);
    // 発言者ごと・順番どおりに渡す。彼の言葉だけ抜き出すと文脈が消える
    const said = talk.slice(-16).map(m => (m.role === "user" ? "本人: " : "コーチ: ") + m.content);
    const latest = [...talk].reverse().find(m => m.role === "user");
    const dist = db.records.reduce((s,r)=>s+(r.dist||0), 0);

    const ctx = {
      今日: today,
      今朝のやりとり: said.length ? said : "なし",
      本人の最新の発言: latest ? latest.content : "なし",
      今日すでに実施した内容: done ? {内容:done.type, 距離:done.dist, 時間:done.time,
        ペース:done.pace, きつさ:done.hard, メモ:done.memo} : "まだ何もしていない",
      曜日: "日月火水木金土"[new Date(today+"T12:00:00").getDay()] + "曜日",
      週ごとの距離: weekly(db.records, today),
      前回の外ランから何日空いたか: sinceLastRun(db.records, today),
      最長距離: Math.max(0, ...db.records.map(r => r.dist || 0)),
      積み上げ: {
        連続日数: streakOf(db.records, today),
        今月の距離: Number(db.records.filter(r => r.date.startsWith(today.slice(0,7)))
                          .reduce((a,r)=>a+(r.dist||0), 0).toFixed(1)),
        通算距離: Number(dist.toFixed(1)),
        記録数: db.records.length
      },
      目標体重: (db.settings && db.settings.goalW) || 60,
      身長cm: (db.settings && db.settings.height) || "不明",
      体組成の現状: trend(db.records),
      現在の天気: await weather(),
      直近の記録: db.records.slice(-21).map(r => ({
        いつ: labelOf(daysAgo(r.date, today)), 日付:r.date, 内容:r.type,
        体重:r.w, 体脂肪率:r.fat, 距離:r.dist,
        きつさ:r.hard, メモ:r.memo, 走った方角:r.dir
      }))
    };

    const ai = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json", "x-api-key":key,
               "anthropic-version":"2023-06-01"},
      body: JSON.stringify({model:"claude-opus-4-5", max_tokens:1500,
        messages:[{role:"user", content: PROMPT + "\n\n" + JSON.stringify(ctx, null, 1)}]})
    });
    if(!ai.ok) return bad(`Anthropic ${ai.status}`, 502);
    const j = await ai.json();
    const txt = j.content.filter(b=>b.type==="text").map(b=>b.text).join("")
                 .replace(/```json|```/g,"").trim();
    const brief = JSON.parse(txt);

    // 外ランならルートも先に用意しておく。
    // ただし手動呼び出しでは時間が足りないので、画面側に任せる。
    const withRoute = scheduled;
    let route = null;
    if(withRoute && !done && brief.mode === "外ラン" && brief.km){
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

    return ok({date:today, brief, route, hasRoute: !!route, scheduled});
  }catch(e){ return bad(e.message, 502); }
};
