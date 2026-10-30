import Editor, { type Config } from "@/components/editor";
import tools from "@/presets/tools.json";

export default function Page() {
  return <Editor config={tools as unknown as Config} />;
}
