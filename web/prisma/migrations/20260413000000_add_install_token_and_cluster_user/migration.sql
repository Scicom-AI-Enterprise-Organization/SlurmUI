-- CreateEnum
CREATE TYPE "ClusterStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'DEGRADED', 'OFFLINE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "ClusterUserStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED');

-- CreateTable
CREATE TABLE "Cluster" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "controllerHost" TEXT NOT NULL,
    "natsCredentials" TEXT NOT NULL,
    "status" "ClusterStatus" NOT NULL DEFAULT 'PROVISIONING',
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "installToken" TEXT,
    "installTokenExpiresAt" TIMESTAMP(3),
    "installTokenUsedAt" TIMESTAMP(3),

    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "slurmJobId" INTEGER,
    "clusterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "partition" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "exitCode" INTEGER,
    "output" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "keycloakId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "unixUid" INTEGER,
    "unixGid" INTEGER,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterUser" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "status" "ClusterUserStatus" NOT NULL DEFAULT 'PENDING',
    "provisionedAt" TIMESTAMP(3),

    CONSTRAINT "ClusterUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cluster_name_key" ON "Cluster"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Cluster_installToken_key" ON "Cluster"("installToken");

-- CreateIndex
CREATE INDEX "Job_clusterId_idx" ON "Job"("clusterId");

-- CreateIndex
CREATE INDEX "Job_userId_idx" ON "Job"("userId");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE UNIQUE INDEX "User_keycloakId_key" ON "User"("keycloakId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_unixUid_key" ON "User"("unixUid");

-- CreateIndex
CREATE UNIQUE INDEX "ClusterUser_userId_clusterId_key" ON "ClusterUser"("userId", "clusterId");

-- CreateIndex
CREATE INDEX "ClusterUser_clusterId_idx" ON "ClusterUser"("clusterId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterUser" ADD CONSTRAINT "ClusterUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterUser" ADD CONSTRAINT "ClusterUser_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
