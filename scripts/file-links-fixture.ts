import {Terminal} from '@xterm/xterm';
import {terminalFileLinks} from '../src/lib/terminalFileLinks.ts';
import '@xterm/xterm/css/xterm.css';
Object.assign(window,{async linkCase(bytes:string,cols:number){
 const host=document.createElement('div');document.body.append(host);const term=new Terminal({cols,rows:10,allowProposedApi:true});term.open(host);
 await new Promise<void>(done=>term.write(bytes,done));const opened:string[]=[];const rows=[];
 for(let i=0;i<term.buffer.active.length;i++){const line=term.buffer.active.getLine(i);if(!line)continue;const links=terminalFileLinks(term.buffer.active,i+1,path=>opened.push(path));rows.push({isWrapped:line.isWrapped,text:line.translateToString(true),links:links.map(link=>({text:link.text,range:link.range}))});for(const link of links)link.activate({button:0} as MouseEvent);}
 term.dispose();host.remove();return {opened:[...new Set(opened)],rows};
}});
