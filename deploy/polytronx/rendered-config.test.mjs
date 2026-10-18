import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productionProblems, rehearsalProblems } from "./rendered-config.mjs";

// Shaped like `docker compose config --format json`, with the fields the rules read.
function productionRender() {
  return {
    name: "polytronx-openinspect",
    services: {
      app: {
        image: "open-inspect-control-plane:test",
        pull_policy: "never",
        ports: [{ host_ip: "127.0.0.1", published: "18787", target: 8787 }],
        networks: { edge: { aliases: ["polytronx-openinspect-app"] }, backend: {}, egress: {} },
      },
      web: {
        image: "open-inspect-web:test",
        pull_policy: "never",
        ports: [{ host_ip: "127.0.0.1", published: "13080", target: 3000 }],
        networks: { edge: { aliases: ["polytronx-openinspect-web"] }, backend: {} },
      },
      litestream: {
        image: "litestream/litestream:test",
        pull_policy: "never",
        networks: { backend: {} },
      },
      "object-store": {
        image: "chrislusf/seaweedfs:test",
        pull_policy: "never",
        networks: { backend: {} },
      },
    },
    networks: {
      edge: { name: "polytronx-edge", external: true },
      backend: { driver: "bridge", internal: true },
      egress: { driver: "bridge" },
    },
  };
}

function rehearsalRender() {
  return {
    name: "polytronx-openinspect-rehearsal",
    services: {
      app: {
        image: "open-inspect-control-plane:test",
        pull_policy: "never",
        networks: { edge: {}, backend: {}, egress: {} },
      },
      web: {
        image: "open-inspect-web:test",
        pull_policy: "never",
        networks: { edge: {}, backend: {} },
      },
      litestream: {
        image: "litestream/litestream:test",
        pull_policy: "never",
        networks: { backend: {} },
      },
      "object-store": {
        image: "chrislusf/seaweedfs:test",
        pull_policy: "never",
        networks: { backend: {} },
      },
    },
    networks: {
      edge: { name: "polytronx-rehearsal-edge", internal: true },
      backend: { internal: true },
      egress: { internal: true },
    },
  };
}

describe("production render", () => {
  it("passes for the intended shape", () => {
    assert.deepEqual(productionProblems(productionRender()), []);
  });

  it("flags a missing unique edge alias, which is what NPM resolves", () => {
    const config = productionRender();
    config.services.web.networks.edge.aliases = [];
    assert.deepEqual(productionProblems(config), [
      "web lacks the edge network alias polytronx-openinspect-web",
    ]);
  });

  it("flags a port published on every interface", () => {
    const config = productionRender();
    config.services.app.ports[0].host_ip = "0.0.0.0";
    assert.deepEqual(productionProblems(config), ["app publishes a port on 0.0.0.0"]);
  });

  it("flags a published object store and an object store on the edge network", () => {
    const config = productionRender();
    config.services["object-store"].ports = [
      { host_ip: "127.0.0.1", published: "8333", target: 8333 },
    ];
    config.services["object-store"].networks.edge = {};
    assert.deepEqual(productionProblems(config), [
      "object-store is attached to the edge network",
      "object-store publishes a port",
      "object-store is attached to a network other than backend",
    ]);
  });

  it("flags an edge network that is not the external live network", () => {
    const config = productionRender();
    config.networks.edge = { name: "polytronx-edge", external: false };
    assert.deepEqual(productionProblems(config), [
      "edge is not the external polytronx-edge network",
    ]);
  });

  it("flags an image service that can pull at up time", () => {
    const config = productionRender();
    delete config.services["object-store"].pull_policy;
    assert.deepEqual(productionProblems(config), ["object-store does not set pull_policy: never"]);
  });
});

describe("rehearsal render", () => {
  it("passes for the intended shape", () => {
    assert.deepEqual(rehearsalProblems(rehearsalRender()), []);
  });

  it("flags any published port, which the overlay must remove", () => {
    const config = rehearsalRender();
    config.services.app.ports = [{ host_ip: "127.0.0.1", published: "18787", target: 8787 }];
    assert.deepEqual(rehearsalProblems(config), ["app publishes a port in the rehearsal"]);
  });

  it("flags a network that can route outside the host", () => {
    const config = rehearsalRender();
    config.networks.egress = { driver: "bridge" };
    assert.deepEqual(rehearsalProblems(config), [
      "egress is not internal in the rehearsal",
      "egress can route outside the host",
    ]);
  });

  it("flags a rehearsal service that joins the live edge network by name", () => {
    const config = rehearsalRender();
    config.networks.edge = { name: "polytronx-edge", internal: true };
    assert.deepEqual(rehearsalProblems(config), [
      "app joins the live edge network",
      "web joins the live edge network",
    ]);
  });

  it("flags a render that is not the rehearsal project", () => {
    const config = rehearsalRender();
    config.name = "polytronx-openinspect";
    assert.deepEqual(rehearsalProblems(config), ["project name is polytronx-openinspect"]);
  });

  it("flags an image service that can pull in the rehearsal too", () => {
    const config = rehearsalRender();
    config.services.litestream.pull_policy = "always";
    assert.deepEqual(rehearsalProblems(config), ["litestream does not set pull_policy: never"]);
  });
});
