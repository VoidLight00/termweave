import {expect,it} from 'bun:test';
import {initialPaneView,readPaneView,writePaneView} from './paneView.ts';
it('keeps machine and pane view choices independent when storage is blocked',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window');
 try{
 Object.defineProperty(globalThis,'window',{configurable:true,value:{get localStorage(){throw Error('blocked')}}});
 writePaneView('local','view-test-a','chat');writePaneView('remote','view-test-a','terminal');writePaneView('local','view-test-b','terminal');
 expect(readPaneView('local','view-test-a')).toBe('chat');expect(readPaneView('remote','view-test-a')).toBe('terminal');expect(readPaneView('local','view-test-b')).toBe('terminal');
 }finally{if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else Reflect.deleteProperty(globalThis,'window')}
});

it('defaults all agent states to terminal including legacy auto',()=>{for(const agent of [null,true,false])for(const choice of ['auto','terminal'] as const)expect(initialPaneView(null,agent,choice)).toBe('terminal');});
it('opens chat only for explicit choices and retains individual pane choices',()=>{expect(initialPaneView('chat',true,'terminal')).toBe('chat');expect(initialPaneView('terminal',true,'chat')).toBe('terminal');expect(initialPaneView(null,true,'chat')).toBe('chat');expect(initialPaneView(null,false,'chat')).toBe('terminal');});
