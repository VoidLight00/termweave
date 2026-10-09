import {expect,it} from 'bun:test';
import {paneNumber} from './paneNumber.ts';
it('uses the persistent global number instead of the session-local index',()=>{
 expect(paneNumber({pane_id:'w99:p1',global_pane_number:3})).toBe('P3');
 expect(paneNumber({pane_id:'w3:p1',global_pane_number:8})).toBe('P8');
});
it('shows full addresses for legacy servers; never invents an ambiguous number',()=>{
 expect(paneNumber('w99:p1')).toBe('w99:p1');
 expect(paneNumber({pane_id:'w3:p1'})).toBe('w3:p1');
 expect(paneNumber({pane_id:'w3:p1',global_pane_number:NaN})).toBe('w3:p1');
});
