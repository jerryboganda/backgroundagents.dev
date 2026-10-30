// Rules for the rendered Compose configuration of the production and rehearsal projects,
// read from `docker compose config --format json`. The compose-render CI job runs the CLI on
// both renders; rendered-config.test.mjs checks the rules on fixtures. A render holds names,
// ports and networks, and never secret values.
//
//   node deploy/polytronx/rendered-config.mjs production <rendered.json>
//   node deploy/polytronx/rendered-config.mjs rehearsal <rendered.json>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIVE_EDGE_NETWORK = "polytronx-edge";

const LOOPBACK = "127.0.0.1";
const EDGE_ALIASES = {
  app: "polytronx-openinspect-app",
  web: "polytronx-openinspect-web",
  docs: "polytronx-openinspect-docs",
};

function portsOf(service) {
  return service?.ports ?? [];
}

function networksOf(service) {
  return Object.keys(service?.networks ?? {}).sort();
}

/** Every service that names an image must set pull_policy: never, so compose cannot pull at up time. */
function pullProblems(services) {
  return Object.entries(services)
    .filter(([, service]) => service.image && service.pull_policy !== "never")
    .map(([name]) => `${name} does not set pull_policy: never`);
}

/** Problems with the production render: loopback-only ingress, an unpublished object store, unique edge aliases. */
export function productionProblems(config) {
  const problems = [];
  const services = config.services ?? {};
  const networks = config.networks ?? {};

  if (config.name !== "polytronx-openinspect") problems.push(`project name is ${config.name}`);
  problems.push(...pullProblems(services));

  for (const [name, alias] of Object.entries(EDGE_ALIASES)) {
    const service = services[name];
    if (!service) {
      problems.push(`service ${name} is missing`);
      continue;
    }
    const ports = portsOf(service);
    if (ports.length === 0) problems.push(`${name} publishes no loopback port`);
    for (const port of ports) {
      if (port.host_ip !== LOOPBACK) {
        problems.push(`${name} publishes a port on ${port.host_ip ?? "all interfaces"}`);
      }
    }
    if (!(service.networks?.edge?.aliases ?? []).includes(alias)) {
      problems.push(`${name} lacks the edge network alias ${alias}`);
    }
  }

  for (const [name, service] of Object.entries(services)) {
    if (!(name in EDGE_ALIASES) && networksOf(service).includes("edge")) {
      problems.push(`${name} is attached to the edge network`);
    }
  }
  if (portsOf(services["object-store"]).length > 0) problems.push("object-store publishes a port");
  if (networksOf(services["object-store"]).join(",") !== "backend") {
    problems.push("object-store is attached to a network other than backend");
  }
  if (networks.edge?.external !== true || networks.edge?.name !== LIVE_EDGE_NETWORK) {
    problems.push(`edge is not the external ${LIVE_EDGE_NETWORK} network`);
  }
  if (networks.backend?.internal !== true) problems.push("backend is not internal");
  return problems;
}

/** Problems with the rehearsal render: nothing published, and no network that can reach outside the host. */
export function rehearsalProblems(config) {
  const problems = [];
  const services = config.services ?? {};
  const networks = config.networks ?? {};

  if (config.name !== "polytronx-openinspect-rehearsal")
    problems.push(`project name is ${config.name}`);
  problems.push(...pullProblems(services));
  for (const network of ["edge", "egress", "backend"]) {
    if (networks[network]?.internal !== true)
      problems.push(`${network} is not internal in the rehearsal`);
  }
  for (const [name, service] of Object.entries(services)) {
    if (portsOf(service).length > 0) problems.push(`${name} publishes a port in the rehearsal`);
    for (const network of networksOf(service)) {
      const declared = networks[network];
      if (!declared) problems.push(`${name} uses the undeclared network ${network}`);
      else if (declared.internal !== true) problems.push(`${network} can route outside the host`);
      else if (declared.name === LIVE_EDGE_NETWORK)
        problems.push(`${name} joins the live edge network`);
    }
  }
  return problems;
}

const RULES = { production: productionProblems, rehearsal: rehearsalProblems };

function main(argv) {
  const [mode, file] = argv;
  const rules = RULES[mode];
  if (!rules || !file) {
    console.error("usage: rendered-config.mjs production|rehearsal <rendered.json>");
    return 2;
  }
  const problems = rules(JSON.parse(readFileSync(file, "utf8")));
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  if (problems.length > 0) return 1;
  console.log(`rendered ${mode} configuration passes its rules`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
