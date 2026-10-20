// Every workflow file has to parse. A workflow that does not parse is refused by
// GitHub before it runs a single job, so the failure shows up as a run with no steps
// and no explanation. This reads each file with a YAML parser and says which file
// broke and where.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const actionsDirectory = new URL("../.github/actions/", import.meta.url);

async function yamlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(...(await yamlFiles(new URL(`${entry.name}/`, directory))));
      continue;
    }
    if (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) {
      found.push(new URL(entry.name, directory));
    }
  }
  return found;
}

test("every workflow file parses as YAML", async () => {
  const files = [...(await yamlFiles(workflowsDirectory)), ...(await yamlFiles(actionsDirectory))];
  assert.ok(files.length > 0, "expected workflow files");
  for (const file of files) {
    const text = await readFile(file, "utf8");
    let document;
    try {
      document = parse(text);
    } catch (error) {
      assert.fail(`${file.pathname} does not parse: ${error.message}`);
    }
    assert.equal(
      document !== null && typeof document === "object" && !Array.isArray(document),
      true,
      `${file.pathname} is not a mapping: the file was read as a plain value`
    );
    assert.ok(document.jobs || document.runs, `${file.pathname} has neither jobs nor runs`);
  }
});

test("every workflow names itself and declares what it may do", async () => {
  const files = await yamlFiles(workflowsDirectory);
  for (const file of files) {
    const document = parse(await readFile(file, "utf8"));
    assert.equal(typeof document.name, "string", `${file.pathname} has no name`);
    assert.ok(document.on, `${file.pathname} has no trigger`);
    assert.ok(document.permissions, `${file.pathname} declares no permissions`);
  }
});
