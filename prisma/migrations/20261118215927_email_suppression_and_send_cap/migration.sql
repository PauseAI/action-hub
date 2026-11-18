-- CreateEnum
CREATE TYPE "EmailSuppressionReason" AS ENUM ('bounce', 'complaint');

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" SERIAL NOT NULL,
    "email_hash" TEXT NOT NULL,
    "reason" "EmailSuppressionReason" NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_send_counts" (
    "hour" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "email_send_counts_pkey" PRIMARY KEY ("hour")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_email_hash_key" ON "email_suppressions"("email_hash");

