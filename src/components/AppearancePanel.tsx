import { useState } from "react";
import { useSettings } from "../lib/settings.ts";
import { COLOR_KEYS, CUSTOM_DEFAULT, FONT_CATALOG, appearanceColors, contrast, parseAppearance, preset } from "../lib/appearance.ts";
import { sanitizeFontFamily } from "../lib/fontFamily.ts";
import { useT } from "../lib/i18n.ts";
import "./AppearancePanel.css";
export function AppearancePanel(){
 const {settings,update,resolvedTheme}=useSettings();const t=useT();const [error,setError]=useState("");
 const active=appearanceColors(settings.appearancePreset,resolvedTheme,settings.customColors);
 const labels={background:t("Background"),surface:t("Panel background"),text:t("Text color"),accent:t("Accent color"),border:t("Border color")};
 const exportTheme=()=>{const data={version:1,appearancePreset:settings.appearancePreset,customColors:settings.customColors,uiFontFamily:settings.uiFontFamily,terminalFontFamily:settings.terminalFontFamily,chatFontFamily:settings.chatFontFamily,theme:settings.theme};const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download='termweave-appearance.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
 return <div className="appearance-panel">
  <label>{t("Open-source themes")}<select aria-label={t("Open-source themes")} className="input" value={settings.appearancePreset} onChange={e=>update({appearancePreset:preset(e.target.value)})}>
   <option value="default">TermWeave</option><option value="catppuccin">{t("Catppuccin themes: Mocha / Latte")}</option><option value="rose-pine">{t("Rosé Pine themes: Main / Dawn")}</option><option value="custom">{t("Custom colors")}</option>
  </select></label>
  <p className="settings-description">{t("Theme colors follow dark or light mode. Fonts are served locally; no external font service is contacted.")}</p>
  {settings.appearancePreset==='custom'&&<div className="appearance-colors">{COLOR_KEYS.map(key=><label key={key}>{labels[key]}<input type="color" value={settings.customColors[key]} onChange={e=>update({customColors:{...settings.customColors,[key]:e.target.value}})}/></label>)}</div>}
  {active&&contrast(active)<4.5&&<p role="status">{t("Text contrast is low. Choose more distinct text and panel colors.")}</p>}
  {([['uiFontFamily',t("Interface font")],['terminalFontFamily',t("Terminal font")],['chatFontFamily',t("Chat font")]] as const).map(([key,label])=><label key={key}>{label}<select aria-label={label} className="input" value={FONT_CATALOG.some(f=>f.family===settings[key])?settings[key]:settings[key]?'custom':''} onChange={e=>{if(e.target.value!=='custom')update({[key]:e.target.value});}}>
   <option value="">{t("Default")}</option>{FONT_CATALOG.filter(f=>key!=='terminalFontFamily'||f.kind==='mono').map(f=><option key={f.name} value={f.family}>{f.name}</option>)}<option value="custom">{t("Custom font family")}</option>
  </select>{key==='uiFontFamily'&&<input className="input" aria-label={t("Custom interface font")} value={settings.uiFontFamily} placeholder={t("Font family, e.g. Noto Sans KR, sans-serif")} maxLength={200} onChange={e=>update({uiFontFamily:sanitizeFontFamily(e.target.value)})}/>}</label>)}
  <div className="appearance-sample">{t("Font preview")} · {t("Sample text: ABC 0123")}<br/><code style={{fontFamily:settings.terminalFontFamily||'monospace'}}>{t("Terminal sample: P3 $ git status")}</code></div>
  <div className="appearance-actions"><button className="btn" onClick={exportTheme}>{t("Export appearance")}</button><label className="btn">{t("Import appearance")}<input type="file" accept="application/json,.json" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>16000)throw Error();const {version,...data}=parseAppearance(await file.text());update({...data,uiFontFamily:sanitizeFontFamily(data.uiFontFamily),terminalFontFamily:sanitizeFontFamily(data.terminalFontFamily),chatFontFamily:sanitizeFontFamily(data.chatFontFamily)});setError('');}catch{setError(t("Invalid appearance file"));}e.target.value='';}}/></label><button className="btn" onClick={()=>update({appearancePreset:'default',customColors:{...CUSTOM_DEFAULT},uiFontFamily:'',terminalFontFamily:'',chatFontFamily:''})}>{t("Reset appearance customization")}</button></div>
  {error&&<p role="alert">{error}</p>}
  <details><summary>{t("Sources and licenses")}</summary><a href="https://github.com/catppuccin/catppuccin" target="_blank" rel="noreferrer">{t("Catppuccin source")}</a> · <a href="/appearance/Catppuccin-LICENSE.txt" target="_blank" rel="noreferrer">{t("MIT license")}</a><br/><a href="https://github.com/rose-pine/rose-pine-theme" target="_blank" rel="noreferrer">{t("Rosé Pine source")}</a> · <a href="/appearance/RosePine-LICENSE.txt" target="_blank" rel="noreferrer">{t("MIT license")}</a>{FONT_CATALOG.map(f=><div key={f.name}><a href={f.source} target="_blank" rel="noreferrer">{f.name}</a> · <a href={f.license} target="_blank" rel="noreferrer">{t("Open Font License")}</a></div>)}</details>
 </div>;
}
