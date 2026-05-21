/**
 * Helpers for branching Aura routes between the legacy baremetal Ansible
 * playbooks (bootstrap.yml, add_node.yml, propagate_config.yml, teardown.yml)
 * and the container-mode equivalents (bootstrap_container.yml et al).
 *
 * Every container playbook expects two extra-vars to be set:
 *   - is_container_cluster=true         — toggles supervisord / no-NFS paths
 *   - allow_cross_node_scheduling=bool  — stamps MaxNodes=1 on partitions
 *                                         when false (the safety lock)
 *
 * Callers should merge the result of {@link containerExtraVars} into the
 * cluster.config blob they pass via `-e @cluster-config.json`, then resolve
 * the playbook filename through {@link bootstrapPlaybook} / similar.
 */

export type ClusterMode = "BAREMETAL" | "CONTAINER";

export interface MinimalClusterForRouting {
  clusterType: ClusterMode | string;
  allowCrossNodeScheduling: boolean;
}

export function isContainerCluster(cluster: MinimalClusterForRouting): boolean {
  return cluster.clusterType === "CONTAINER";
}

/**
 * Returns the extra-vars container playbooks need. For baremetal clusters
 * this is an empty object so caller can spread it unconditionally:
 *
 *   const extra = { ...config, ...containerExtraVars(cluster) };
 */
export function containerExtraVars(cluster: MinimalClusterForRouting): Record<string, unknown> {
  if (!isContainerCluster(cluster)) return {};
  return {
    is_container_cluster: true,
    allow_cross_node_scheduling: !!cluster.allowCrossNodeScheduling,
  };
}

export function bootstrapPlaybook(cluster: MinimalClusterForRouting): string {
  return isContainerCluster(cluster) ? "bootstrap_container.yml" : "bootstrap.yml";
}

export function addNodePlaybook(cluster: MinimalClusterForRouting): string {
  return isContainerCluster(cluster) ? "add_node_container.yml" : "add_node.yml";
}

export function propagateConfigPlaybook(cluster: MinimalClusterForRouting): string {
  return isContainerCluster(cluster) ? "propagate_config_container.yml" : "propagate_config.yml";
}

export function teardownPlaybook(cluster: MinimalClusterForRouting): string {
  return isContainerCluster(cluster) ? "teardown_container.yml" : "teardown.yml";
}
