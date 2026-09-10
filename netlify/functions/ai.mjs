/* Anthropic API への中継。キーはここに置き、ブラウザには出さない。
   リクエストの中身（モデル・メッセージ）はそのまま流す。

   必要な環境変数:
     ANTHROPIC_API_KEY
     APP_TOKEN          端末で入力する合言葉 */

const CORS = {"Access-Control-Allow-Origin":"*", "Content-Type":"application/json"};
const bad = (m,s=400) => new Response(JSON.stringify({error:m}), {status:s, headers:CORS});

export default async (req) => {
  if(req.method === "OPTIONS") return new Response("", {headers:{...CORS,
    "Access-Control-Allow-Headers":"Content-Type", "Access-Control-Allow-Methods":"POST"}});
  if(req.method !== "POST") return bad("POSTしてください", 405);

  const key = process.env.ANTHROPIC_API_KEY;
  if(!key) return bad("ANTHROPIC_API_KEY が未設定です");

  const url = new URL(req.url);
  if(process.env.APP_TOKEN && url.searchParams.get("t") !== process.env.APP_TOKEN)
    return bad("合言葉が違います", 401);

  let body;
  try{ body = await req.json(); }catch{ return bad("JSONを解釈できません"); }

  try{
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json", "x-api-key":key,
               "anthropic-version":"2023-06-01"},
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return new Response(text, {status:res.status, headers:CORS});
  }catch(e){ return bad(e.message, 502); }
};
