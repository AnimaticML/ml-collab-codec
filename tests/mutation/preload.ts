import { plugin } from "bun";
import { FAULTS } from "./faults.ts";

/**
 * `bun test --preload ./tests/mutation/preload.ts` with MUTATION=<fault id>
 * loads the implementation with that one fault applied (MR38).
 */
const id = process.env["MUTATION"];
const fault = FAULTS.find((candidate) => candidate.id === id);
if (fault === undefined) throw new Error(`unknown mutation ${String(id)}`);

plugin({
  name: "mutation",
  setup(build) {
    const escaped = fault.file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    build.onLoad({ filter: new RegExp(`${escaped}$`) }, async (args) => {
      const source = await Bun.file(args.path).text();
      const occurrences = source.split(fault.find).length - 1;
      if (occurrences !== 1)
        throw new Error(`mutation ${fault.id}: site found ${occurrences} times in ${fault.file}`);
      console.error(`MUTATION APPLIED ${fault.id}`);
      return { contents: source.replace(fault.find, fault.replace), loader: "tsx" };
    });
  },
});
