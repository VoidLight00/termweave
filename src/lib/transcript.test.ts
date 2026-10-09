import {describe,expect,it} from 'bun:test';import {toTranscriptMessages} from './transcript.ts';
/** Entirely synthetic TUI fixture; no real user or provider transcript. */
const SYNTHETIC_READ='[Synthetic model] │ /synthetic/project\n❯ List fixture widgets\n────────\nThere are three synthetic widgets.\n\nEach widget is test-only.\n✳ Completed synthetic turn\n❯ Show fixture colors\nBlue and green.';
describe('synthetic transcript parsing',()=>{
 it('separates user markers, rules, agent paragraphs and status',()=>{expect(toTranscriptMessages(SYNTHETIC_READ)).toEqual([{role:'status',text:'[Synthetic model] │ /synthetic/project'},{role:'user',text:'List fixture widgets'},{role:'agent',text:'There are three synthetic widgets.'},{role:'agent',text:'Each widget is test-only.'},{role:'status',text:'✳ Completed synthetic turn'},{role:'user',text:'Show fixture colors'},{role:'agent',text:'Blue and green.'}]);});
 it('returns no messages for blank/rule-only reads',()=>{expect(toTranscriptMessages('\n────────\n')).toEqual([]);});
 it('preserves multiline agent paragraphs and CRLF without inventing speakers',()=>{expect(toTranscriptMessages('Synthetic first\r\nSynthetic second\r\n\r\nSynthetic third')).toEqual([{role:'agent',text:'Synthetic first\nSynthetic second'},{role:'agent',text:'Synthetic third'}]);});
 it('ignores an empty prompt and groups status chrome',()=>{expect(toTranscriptMessages('❯ \nContext 25%\nUsage 1%\nFixture output')).toEqual([{role:'status',text:'Context 25%\nUsage 1%'},{role:'agent',text:'Fixture output'}]);});
});
