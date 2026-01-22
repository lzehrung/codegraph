import { Button } from "./components/Button";
import { formatLabel } from "./utils";

export function App() {
  const label = formatLabel("Click me");
  const rendered = Button({ label });
  return <div>{rendered}</div>;
}
