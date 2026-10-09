import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserPanel } from "../src/components/BrowserPanel.tsx";
import "../src/styles.css";
const layout = { kind: "split", ratio: 0.37, tabs: ["test-pane-a", "test-pane-b"], active: "test-pane-b" };
function Fixture() {
  const [machine, setMachine] = useState("local");
  return <main style={{ width: "100%", maxWidth: 1000, margin: "auto" }}>
    <button onClick={() => setMachine(machine === "local" ? "remote-b" : "local")}>Switch test PC</button>
    <BrowserPanel machineId={machine} />
    <div id="terminal-sentinel" data-layout={JSON.stringify(layout)} tabIndex={0}>Isolated terminal view sentinel</div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
