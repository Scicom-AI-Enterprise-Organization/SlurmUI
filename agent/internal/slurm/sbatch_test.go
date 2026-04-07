package slurm

import (
	"testing"
)

func TestBuildSbatchArgs(t *testing.T) {
	opts := &SbatchOpts{
		JobName:   "test-job",
		Partition: "gpu",
		WorkDir:   "/tmp/work",
		Nodes:     2,
		NTasks:    8,
		GPUs:      "4",
		TimeLimit: "1:00:00",
		EnvVars: map[string]string{
			"MY_VAR": "value",
		},
		ExtraArgs: []string{"--mem=4G"},
	}

	args := buildSbatchArgs(opts, "/tmp/script.sh")

	// Check required args are present.
	assertContains(t, args, "--job-name=test-job")
	assertContains(t, args, "--partition=gpu")
	assertContains(t, args, "--chdir=/tmp/work")
	assertContains(t, args, "--nodes=2")
	assertContains(t, args, "--ntasks=8")
	assertContains(t, args, "--gpus=4")
	assertContains(t, args, "--time=1:00:00")
	assertContains(t, args, "--mem=4G")

	// Script path should be last.
	if args[len(args)-1] != "/tmp/script.sh" {
		t.Errorf("expected script path as last arg, got %q", args[len(args)-1])
	}
}

func TestBuildSbatchArgs_Minimal(t *testing.T) {
	opts := &SbatchOpts{}
	args := buildSbatchArgs(opts, "/tmp/script.sh")

	// Only the script path should be present (no optional flags).
	if args[len(args)-1] != "/tmp/script.sh" {
		t.Errorf("expected script path as last arg, got %q", args[len(args)-1])
	}
}

func assertContains(t *testing.T, args []string, expected string) {
	t.Helper()
	for _, arg := range args {
		if arg == expected {
			return
		}
	}
	t.Errorf("expected args to contain %q, got %v", expected, args)
}
