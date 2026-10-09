import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil } from "lucide-react";
import { fetchSession, renamePane } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import "./RenamePaneButton.css";

type Target = {pane_id: string; terminal_id: string; label?: string | null};
export function RenamePaneButton({pane,machineId,onRenamed,compact=false,disabled=false,dialogOnly=false,onClose}: {
  pane: Target; machineId: string; onRenamed: () => void | Promise<void>; compact?: boolean; disabled?: boolean; dialogOnly?: boolean; onClose?: () => void;
}) {
  const t=useT();const id=useId();const dialog=useRef<HTMLDialogElement>(null);
  const [target,setTarget]=useState<Target|null>(dialogOnly?{...pane}:null);const [name,setName]=useState(dialogOnly?(pane.label??""):"");
  const [pending,setPending]=useState(false);const [error,setError]=useState("");
  useEffect(()=>{if(target)dialog.current?.showModal();},[target]);
  const save=async()=>{
    if(!target||pending)return;setPending(true);setError("");
    try{
      await renamePane(target.pane_id,name.trim(),machineId,target.terminal_id);
      const current=(await fetchSession(machineId)).panes.find(p=>p.terminal_id===target.terminal_id);
      if(!current || (current.label??"")!==name.trim())throw new Error(t("Terminal name was not confirmed. Refresh the list."));
      await onRenamed();dialog.current?.close();setTarget(null);onClose?.();
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setPending(false);}
  };
  return <>{!dialogOnly&&<button type="button" className={compact?"sidebar-row-action terminal-rename":undefined}
    disabled={disabled||!pane.terminal_id} aria-label={t("Rename terminal {id}",{id:pane.pane_id})}
    title={t("Rename terminal {id}",{id:pane.pane_id})}
    onClick={event=>{event.stopPropagation();setName(pane.label??"");setError("");setTarget({...pane});}}>
    {compact?<Pencil aria-hidden="true"/>:t("Rename terminal")}</button>}
    {target&&createPortal(<dialog ref={dialog} className="modal rename-terminal-dialog" aria-labelledby={id}
      onCancel={event=>{if(pending)event.preventDefault();}} onClose={()=>{if(!pending){setTarget(null);onClose?.();}}}>
      <form onSubmit={event=>{event.preventDefault();void save();}}>
        <header className="modal-header"><h2 className="modal-title" id={id}>{t("Rename terminal")}</h2></header>
        <div className="modal-body"><label>{t("Terminal name")}<input className="input" autoFocus maxLength={200}
          disabled={pending} value={name} onChange={event=>setName(event.target.value)}/></label>
          {error&&<p role="alert" className="confirm-error">{error}</p>}</div>
        <footer className="modal-footer"><button className="btn" type="button" disabled={pending} onClick={()=>{dialog.current?.close();setTarget(null);onClose?.();}}>{t("Cancel")}</button>
          <button className="btn" type="submit" disabled={pending}>{t("Rename")}</button></footer>
      </form>
    </dialog>,document.body)}
  </>;
}
