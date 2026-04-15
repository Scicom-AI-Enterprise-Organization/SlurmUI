ALTER TABLE "User" ADD COLUMN "unixUsername" TEXT;
CREATE UNIQUE INDEX "User_unixUsername_key" ON "User"("unixUsername");
