CREATE TABLE "AppSession" (
    "id"        TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "type"      TEXT NOT NULL,
    "partition" TEXT NOT NULL,
    "status"    TEXT NOT NULL DEFAULT 'STARTING',
    "accessUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AppSession_clusterId_idx" ON "AppSession"("clusterId");
CREATE INDEX "AppSession_userId_idx"    ON "AppSession"("userId");

ALTER TABLE "AppSession" ADD CONSTRAINT "AppSession_clusterId_fkey"
    FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppSession" ADD CONSTRAINT "AppSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
