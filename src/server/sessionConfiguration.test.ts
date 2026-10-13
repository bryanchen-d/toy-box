import { expect, test } from "bun:test";
import { getSessionConfiguration } from "./sessionConfiguration";
import { screenTools } from "@screens/server/tools";

test("screen tools follow the approved session role policy", async () => {
  const names = new Set<string>(screenTools.map((tool) => tool.name));
  for (const role of ["standard", "hyper", "automation"] as const) {
    const configuration = await getSessionConfiguration("screen-policy-test", role);
    const tools = configuration.tools.filter((tool) => names.has(tool.name));
    expect(tools.length).toBe(role === "automation" ? 0 : names.size);
  }
});
