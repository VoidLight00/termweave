/** Palettes adapted from Catppuccin and Rosé Pine (MIT); see public/appearance. */
export type AppearancePreset = "default" | "catppuccin" | "rose-pine" | "custom";
export type ThemeColors = { background: string; surface: string; text: string; accent: string; border: string };
export const CUSTOM_DEFAULT: ThemeColors = {background:"#12100e",surface:"#181613",text:"#d8d0c3",accent:"#f0a830",border:"#3e3830"};
export const COLOR_KEYS = ["background","surface","text","accent","border"] as const;
export const FONT_CATALOG = [
 {name:"JetBrains Mono",family:'"TermWeave JetBrains Mono", "TermWeave D2Coding"',kind:"mono",source:"https://github.com/JetBrains/JetBrainsMono",license:"/appearance/JetBrainsMono-OFL.txt"},
 {name:"D2Coding",family:'"TermWeave D2Coding"',kind:"mono",source:"https://github.com/naver/d2-coding-font",license:"/appearance/D2Coding-OFL.txt"},
 {name:"Noto Sans KR",family:'"TermWeave Noto Sans KR"',kind:"sans",source:"https://github.com/google/fonts/tree/main/ofl/notosanskr",license:"/appearance/NotoSansKR-OFL.txt"},
] as const;
export function preset(value: unknown): AppearancePreset { return value==="catppuccin"||value==="rose-pine"||value==="custom"?value:"default"; }
export function colors(value: unknown): ThemeColors {
 const raw=value&&typeof value==="object"?value as Record<string,unknown>:{};
 return Object.fromEntries(COLOR_KEYS.map(k=>[k,typeof raw[k]==="string"&&/^#[0-9a-f]{6}$/i.test(raw[k] as string)?raw[k]:CUSTOM_DEFAULT[k]])) as ThemeColors;
}
export function appearanceColors(name: AppearancePreset, mode:"dark"|"light",custom:ThemeColors):ThemeColors|null {
 if(name==="default")return null;
 if(name==="custom")return colors(custom);
 if(name==="catppuccin")return mode==="dark"?{background:"#1e1e2e",surface:"#181825",text:"#cdd6f4",accent:"#cba6f7",border:"#45475a"}:{background:"#eff1f5",surface:"#e6e9ef",text:"#4c4f69",accent:"#8839ef",border:"#bcc0cc"};
 return mode==="dark"?{background:"#191724",surface:"#1f1d2e",text:"#e0def4",accent:"#c4a7e7",border:"#403d52"}:{background:"#faf4ed",surface:"#fffaf3",text:"#575279",accent:"#907aa9",border:"#cecacd"};
}
export function appearanceVariables(c:ThemeColors):Record<string,string>{
 return {"--bg":c.background,"--bg-panel":c.surface,"--bg-elevated":c.surface,"--bg-hover":c.border,"--bg-input":c.background,"--border":c.border,"--border-strong":c.border,"--text":c.text,"--text-strong":c.text,"--text-dim":c.text,"--accent":c.accent,"--primary":c.accent,"--primary-hover":c.accent,"--primary-text":c.background,"--accent-tint":c.accent+"22","--primary-tint":c.accent+"22","--term-bg":c.surface,"--term-fg":c.text,"--term-cursor":c.accent,"--term-selection":c.border};
}
export function contrast(c:ThemeColors):number {
 const luminance=(hex:string)=>{const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return rgb[0]!*.2126+rgb[1]!*.7152+rgb[2]!*.0722;};
 const a=luminance(c.text),b=luminance(c.surface);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}
export interface AppearanceExport {version:1;appearancePreset:AppearancePreset;customColors:ThemeColors;uiFontFamily:string;terminalFontFamily:string;chatFontFamily:string;theme:"dark"|"light"|"system"}
export function parseAppearance(text:string):AppearanceExport {
 if(text.length>16000)throw new Error("Invalid appearance file");
 const data=JSON.parse(text);if(!data||data.version!==1||!["default","catppuccin","rose-pine","custom"].includes(data.appearancePreset)||!["dark","light","system"].includes(data.theme))throw new Error("Invalid appearance file");
 for(const k of COLOR_KEYS)if(!/^#[0-9a-f]{6}$/i.test(data.customColors?.[k]))throw new Error("Invalid appearance file");
 for(const key of ["uiFontFamily","terminalFontFamily","chatFontFamily"])if(typeof data[key]!=="string"||data[key].length>240)throw new Error("Invalid appearance file");
 return {version:1,appearancePreset:data.appearancePreset,customColors:colors(data.customColors),theme:data.theme,uiFontFamily:data.uiFontFamily,terminalFontFamily:data.terminalFontFamily,chatFontFamily:data.chatFontFamily};
}
