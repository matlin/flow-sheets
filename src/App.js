import FlowGraph from "./flow-graph";
import "./styles.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/select/lib/css/blueprint-select.css";
import "@blueprintjs/popover2/lib/css/blueprint-popover2.css";

export default function App() {
  return (
    <div className="canvas">
      <FlowGraph />
    </div>
  );
}