import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { PaneTerminal } from '../src/components/PaneTerminal.tsx';
import { DockDivider } from '../src/components/DockDivider.tsx';
import { SettingsProvider } from '../src/lib/settings.ts';
import '../src/styles.css';
import '../src/components/SplitTerminals.css';
import '../src/components/DockLayout.css';

const terms: Terminal[] = [];
const open = Terminal.prototype.open;
Terminal.prototype.open = function (parent) { terms.push(this); return open.call(this, parent); };
Object.assign(window, { renderTerms: terms });
function Fixture() {
  const [ratio, setRatio] = useState(0.5);
  const [mode, setMode] = useState('single');
  const [pane, setPane] = useState('synthetic-a');
  const [role, setRole] = useState<'interact' | 'observe'>('interact');
  const [fontSize, setFontSize] = useState(14);
  const leaf = (id: string) => <section className="split-pane dock-group" data-fixture-pane={id}>
    <div className="dock-drop-body"><PaneTerminal paneId={(window as any).nativeRenderPane ?? id} view="terminal" terminalFontSize={fontSize}
      terminalWheelSpeed={1} terminalFontFamily="" theme="dark" palette="amber" role={role} autoSelected /></div>
  </section>;
  return <><nav><button onClick={() => setMode('single')}>Single</button><button onClick={() => setMode('columns')}>Columns</button>
    <button onClick={() => setMode('rows')}>Rows</button><button onClick={() => setMode(mode === 'zoom' ? 'columns' : 'zoom')}>Zoom</button>
    <button onClick={() => setPane(pane === 'synthetic-a' ? 'synthetic-b' : 'synthetic-a')}>Tab</button>
    <button onClick={() => setRole(role === 'interact' ? 'observe' : 'interact')}>Role</button>
    <button onClick={() => setFontSize(fontSize === 14 ? 18 : 14)}>Font</button></nav>
    <main className="terminal-host" style={{ height: 'calc(100dvh - 60px)', width: '100%', minWidth: 0 }}>
      <div className="split-workspace"><div className="dock-root">
        {['single', 'zoom'].includes(mode) ? leaf(pane) : <div className={`dock-split dock-${mode}`} style={mode === 'columns'
          ? { gridTemplateColumns: `${ratio}fr 1px ${1 - ratio}fr` } : { gridTemplateRows: `${ratio}fr 1px ${1 - ratio}fr` }}>
          {leaf(pane)}<DockDivider node={{ kind: 'split', id: 'fixture-split', axis: mode as 'columns' | 'rows', ratio,
            first: { kind: 'group', id: 'a', tabs: [], active: null }, second: { kind: 'group', id: 'b', tabs: [], active: null } }}
            onResize={(_, value) => setRatio(value)} />{leaf('synthetic-c')}
        </div>}
      </div></div>
    </main></>;
}
createRoot(document.getElementById('root')!).render(<SettingsProvider><Fixture /></SettingsProvider>);
