"""
Pins the MaxNodes=1 contract on roles/slurm_controller/templates/slurm.conf.j2.

When (is_container_cluster=True AND allow_cross_node_scheduling=False), every
PartitionName= line must carry the `MaxNodes=1` directive — this is the
Slurm-side enforcement of the cross-node toggle, and the lock that keeps
container jobs out of inter-container NCCL/CCL latency. Every other
combination must NOT carry the directive (baremetal multi-node, container
with cross-node enabled).

Run:
    python3 -m pytest ansible/tests/test_slurm_conf_template.py -v
"""

import os
from pathlib import Path

import pytest
from jinja2 import Environment, FileSystemLoader


REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_DIR = REPO_ROOT / "ansible" / "roles" / "slurm_controller" / "templates"


def _render(slurm_nodes, slurm_partitions, **flags):
    """Render slurm.conf.j2 with the given vars and return the text."""
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        keep_trailing_newline=True,
        trim_blocks=False,
        lstrip_blocks=False,
    )
    tpl = env.get_template("slurm.conf.j2")
    return tpl.render(
        slurm_cluster_name="testcluster",
        slurm_controller_host="10.0.0.1",
        slurm_user="slurm",
        slurm_spool_dir="/var/spool/slurm",
        slurm_log_dir="/var/log/slurm",
        ansible_hostname="ctrl1",
        ansible_processor_vcpus=16,
        ansible_memtotal_mb=64000,
        slurm_nodes=slurm_nodes,
        slurm_partitions=slurm_partitions,
        vault_slurmdbd_storage_pass="",
        **flags,
    )


PARTITION = {
    "name": "main",
    "nodes": "worker1,worker2",
    "max_time": "INFINITE",
    "default": True,
}
NODE = {"expression": "worker1", "cpus": 8, "gpus": 0, "memory_mb": 32000}


def test_baremetal_no_max_nodes_directive():
    """Default baremetal cluster — no MaxNodes=1 anywhere."""
    out = _render([NODE], [PARTITION])
    assert "MaxNodes=1" not in out


def test_baremetal_with_cross_node_true_no_effect():
    """allow_cross_node_scheduling has no effect on baremetal."""
    out = _render([NODE], [PARTITION], is_container_cluster=False, allow_cross_node_scheduling=True)
    assert "MaxNodes=1" not in out


def test_container_locked_emits_max_nodes_on_user_partition():
    """The combo we care about: container + cross-node OFF → MaxNodes=1 set."""
    out = _render([NODE], [PARTITION], is_container_cluster=True, allow_cross_node_scheduling=False)
    assert "PartitionName=main" in out
    # The directive must appear on the same line as PartitionName so Slurm
    # parses it as part of the partition definition, not a standalone line.
    partition_line = next(line for line in out.splitlines() if line.startswith("PartitionName=main"))
    assert "MaxNodes=1" in partition_line


def test_container_open_no_max_nodes_directive():
    """Container + cross-node ON → MaxNodes=1 absent (multi-node allowed)."""
    out = _render([NODE], [PARTITION], is_container_cluster=True, allow_cross_node_scheduling=True)
    assert "MaxNodes=1" not in out


def test_container_locked_on_auto_fallback_partition():
    """When no slurm_partitions configured but nodes exist, the auto-fallback
    `main` partition must also carry MaxNodes=1 in the locked container case.
    Otherwise the safety lock has a hole during a fresh bootstrap."""
    out = _render([NODE], [], is_container_cluster=True, allow_cross_node_scheduling=False)
    fallback_lines = [line for line in out.splitlines() if line.startswith("PartitionName=main")]
    assert len(fallback_lines) == 1
    assert "MaxNodes=1" in fallback_lines[0]


def test_container_locked_on_empty_nodes_bootstrap_partition():
    """The very-first-bootstrap path (no nodes yet) registers the controller
    itself as a single-node main partition. Same lock applies."""
    out = _render([], [], is_container_cluster=True, allow_cross_node_scheduling=False)
    bootstrap_lines = [line for line in out.splitlines() if line.startswith("PartitionName=main")]
    assert len(bootstrap_lines) == 1
    assert "MaxNodes=1" in bootstrap_lines[0]


def test_container_locked_emits_on_every_partition():
    """Multiple partitions → every one of them carries MaxNodes=1."""
    parts = [
        {"name": "main", "nodes": "w1,w2", "max_time": "INFINITE", "default": True},
        {"name": "gpu", "nodes": "g1", "max_time": "1:00:00", "default": False},
    ]
    out = _render([NODE], parts, is_container_cluster=True, allow_cross_node_scheduling=False)
    main_line = next(line for line in out.splitlines() if line.startswith("PartitionName=main"))
    gpu_line = next(line for line in out.splitlines() if line.startswith("PartitionName=gpu"))
    assert "MaxNodes=1" in main_line
    assert "MaxNodes=1" in gpu_line


def test_max_nodes_directive_only_on_partition_lines():
    """Don't accidentally stamp MaxNodes=1 on NodeName or other lines."""
    out = _render([NODE], [PARTITION], is_container_cluster=True, allow_cross_node_scheduling=False)
    for line in out.splitlines():
        if "MaxNodes=1" in line:
            assert line.startswith("PartitionName="), (
                f"MaxNodes=1 leaked onto non-partition line: {line!r}"
            )
