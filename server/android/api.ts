import { AndroidError, type AndroidRuntime } from "./runtime.ts";
export async function handleAndroidRequest(request: Request, runtime: AndroidRuntime, readOnly: boolean): Promise<Response> {
  const path = new URL(request.url).pathname;
  const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
  try {
    if (request.method === "GET" && path === "/api/android") return json(await runtime.overview());
    if (readOnly) return json({error:{code:"read_only"}},403);
    if(request.method!=="POST")return json({error:{code:"method_not_allowed"}},405);
    const raw=await request.text();if(raw.length>2048)throw new AndroidError("request_too_large",413);
    let body: Record<string,unknown>;try { body=JSON.parse(raw); }catch{throw new AndroidError("invalid_json",400);}
    if(!body||typeof body!=="object"||Array.isArray(body))throw new AndroidError("invalid_json",400);
    const id=typeof body.id==="string"?body.id:"";
    switch(path){
      case "/api/android/register":return json(await runtime.register(id,typeof body.name==="string"?body.name:""));
      case "/api/android/forget":return json(await runtime.forget(id));
      case "/api/android/pair":return json(await runtime.pair(body.endpoint,body.code));
      case "/api/android/connect":return json(await runtime.connect(body.endpoint));
      case "/api/android/mirror/start":
        if(!["standard","light","screen-off"].includes(body.mode as string))throw new AndroidError("invalid_mode",400);
        return json(await runtime.start(id,body.mode as "standard"|"light"|"screen-off"));
      case "/api/android/mirror/stop":return json(await runtime.stop(id));
      default:return json({error:{code:"not_found"}},404);
    }
  }catch(error){return json({error:{code:error instanceof AndroidError?error.code:"android_unavailable"}},error instanceof AndroidError?error.status:503);}
}
