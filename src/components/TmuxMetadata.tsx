import {useEffect,useState} from "react";
import type {TmuxPaneState} from "../../shared/tmux.ts";
import {useT} from "../lib/i18n.ts";

export function TmuxMetadata({target}:{target:TmuxPaneState}) {
  const t=useT();
  const [metadata,setMetadata]=useState<{cwd:string;ports:number[]|null;git:{branch:string|null;dirty:boolean;ahead:number;behind:number}|null}|null>(null);
  useEffect(()=>{
    let disposed=false;let pending=false;const abort=new AbortController();setMetadata(null);
    const load=async()=>{
      if(pending)return;pending=true;
      try{
        const params=new URLSearchParams({socket:target.socket,generation:target.generation,paneId:target.paneId});
        const response=await fetch(`/api/tmux/metadata?${params}`,{cache:"no-store",signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)])});
        if(!response.ok)throw new Error("metadata unavailable");
        const value=await response.json();if(!disposed)setMetadata(value);
      }catch{if(!disposed)setMetadata(null);}finally{pending=false;}
    };
    void load();const timer=setInterval(()=>{if(document.visibilityState!=="hidden")void load();},15000);
    return()=>{disposed=true;abort.abort();clearInterval(timer);};
  },[target.socket,target.generation,target.paneId]);
  return metadata && <div className="tmux-metadata"><span>{metadata.cwd}</span>{metadata.git && <span title={t("Git working tree")}>
    {metadata.git.branch??t("Detached HEAD")}{metadata.git.dirty?" *":""}{metadata.git.ahead?` ↑${metadata.git.ahead}`:""}{metadata.git.behind?` ↓${metadata.git.behind}`:""}
  </span>}{metadata.ports && metadata.ports.length > 0 && <span>{t("Listening ports")}: {metadata.ports.join(", ")}</span>}</div>;
}
