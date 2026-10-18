import { createRoot } from 'react-dom/client';
import { AppearancePanel } from '../src/components/AppearancePanel.tsx';
import { SettingsProvider } from '../src/lib/settings.ts';
import '../src/styles.css';

createRoot(document.getElementById('root')!).render(<SettingsProvider><div style={{ padding: 16 }}><AppearancePanel /></div></SettingsProvider>);
