/**
 * Unit tests for lib/container-cluster.ts — the routing decisions every
 * playbook-running API route relies on. If any of these regress, container
 * clusters silently end up running the baremetal playbooks (or vice versa)
 * which produces fascinating failure modes.
 *
 * Run with:
 *   node --import tsx --test --test-reporter=spec test/container-cluster.unit.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  isContainerCluster,
  containerExtraVars,
  bootstrapPlaybook,
  addNodePlaybook,
  propagateConfigPlaybook,
  teardownPlaybook,
} = await import("../lib/container-cluster.ts");

const baremetal = { clusterType: "BAREMETAL", allowCrossNodeScheduling: false };
const containerLocked = { clusterType: "CONTAINER", allowCrossNodeScheduling: false };
const containerOpen = { clusterType: "CONTAINER", allowCrossNodeScheduling: true };

test("isContainerCluster: BAREMETAL is false", () => {
  assert.equal(isContainerCluster(baremetal), false);
});

test("isContainerCluster: CONTAINER is true", () => {
  assert.equal(isContainerCluster(containerLocked), true);
  assert.equal(isContainerCluster(containerOpen), true);
});

test("isContainerCluster: unknown string defaults to false (treat as baremetal)", () => {
  // Defensive — prevents an accidental DB value like "" or null from being
  // misinterpreted as CONTAINER and routing to the wrong playbook.
  assert.equal(isContainerCluster({ clusterType: "", allowCrossNodeScheduling: false }), false);
  assert.equal(isContainerCluster({ clusterType: "VM", allowCrossNodeScheduling: false }), false);
});

test("containerExtraVars: baremetal returns empty object (caller can spread unconditionally)", () => {
  assert.deepEqual(containerExtraVars(baremetal), {});
});

test("containerExtraVars: container with cross-node off", () => {
  assert.deepEqual(containerExtraVars(containerLocked), {
    is_container_cluster: true,
    allow_cross_node_scheduling: false,
  });
});

test("containerExtraVars: container with cross-node on", () => {
  assert.deepEqual(containerExtraVars(containerOpen), {
    is_container_cluster: true,
    allow_cross_node_scheduling: true,
  });
});

test("containerExtraVars: coerces truthy-but-non-bool to real bool", () => {
  // Guards against accidentally shipping `1` or `"true"` into the
  // playbook — Jinja's `default(false)` quirks then bite the MaxNodes
  // conditional. The lib must always emit a real boolean.
  const result = containerExtraVars({ clusterType: "CONTAINER", allowCrossNodeScheduling: 1 });
  assert.equal(result.allow_cross_node_scheduling, true);
  assert.equal(typeof result.allow_cross_node_scheduling, "boolean");
});

test("bootstrapPlaybook: baremetal → bootstrap.yml", () => {
  assert.equal(bootstrapPlaybook(baremetal), "bootstrap.yml");
});

test("bootstrapPlaybook: container → bootstrap_container.yml", () => {
  assert.equal(bootstrapPlaybook(containerLocked), "bootstrap_container.yml");
  assert.equal(bootstrapPlaybook(containerOpen), "bootstrap_container.yml");
});

test("addNodePlaybook: branches on clusterType", () => {
  assert.equal(addNodePlaybook(baremetal), "add_node.yml");
  assert.equal(addNodePlaybook(containerLocked), "add_node_container.yml");
});

test("propagateConfigPlaybook: branches on clusterType", () => {
  assert.equal(propagateConfigPlaybook(baremetal), "propagate_config.yml");
  assert.equal(propagateConfigPlaybook(containerLocked), "propagate_config_container.yml");
});

test("teardownPlaybook: branches on clusterType", () => {
  assert.equal(teardownPlaybook(baremetal), "teardown.yml");
  assert.equal(teardownPlaybook(containerLocked), "teardown_container.yml");
});

test("cross-node toggle doesn't change playbook selection", () => {
  // The toggle changes what's *inside* slurm.conf (MaxNodes=1 directive),
  // not which playbook runs. Same playbook for both cross-node states.
  assert.equal(bootstrapPlaybook(containerLocked), bootstrapPlaybook(containerOpen));
  assert.equal(addNodePlaybook(containerLocked), addNodePlaybook(containerOpen));
  assert.equal(teardownPlaybook(containerLocked), teardownPlaybook(containerOpen));
});
