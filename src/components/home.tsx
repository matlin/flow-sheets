import { useHistory } from "react-router-dom";
import SelectGraphDialog from "./select-graph-dialog";

export default function Home() {
  const history = useHistory();
  return (
    <SelectGraphDialog
      onClose={() => {}}
      isOpen={true}
      onNew={(graphId) => {
        history.push(`/${graphId}`);
      }}
    />
  );
}
