# slurm-node image

Pre-baked Slurm single-node image for SlurmUI "RunPod Instant Cluster" pods.
A pod launched from this image self-configures Slurm on boot (see `entrypoint.sh`),
so there is no apt bootstrap step.

This image is **built and pushed manually** (no CI). It lives on **ECR Public** so
RunPod can pull it anonymously (no registry credentials needed). The app uses it
by default via `DEFAULT_SLURM_NODE_IMAGE` in `web/lib/gpu-provider.ts`, overridable
with the `AURA_SLURM_NODE_IMAGE` env var.

Current image: `public.ecr.aws/o6x1g6b0/slurm-node:latest`

## Build and push

RunPod GPU hosts are amd64, so the image must be amd64.

```bash
REG=public.ecr.aws/o6x1g6b0/slurm-node

# Log in to ECR Public (always us-east-1)
aws ecr-public get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin public.ecr.aws

# Build amd64 and push
docker buildx build --platform linux/amd64 --push \
  -t "$REG:latest" docker/slurm-node
```

Notes:
- On an Apple-silicon Mac the amd64 build runs under emulation and is slow. A
  native amd64 machine (or a throwaway EC2 amd64 instance) is much faster.
- The base is `runpod/pytorch:...-cu1281-...`, so the image ships CUDA 12.8. Keep
  `SLURM_NODE_CUDA_VERSIONS` in `gpu-provider.ts` in sync if you change the base.
- If you push a new tag, update `DEFAULT_SLURM_NODE_IMAGE` (or set
  `AURA_SLURM_NODE_IMAGE`).
