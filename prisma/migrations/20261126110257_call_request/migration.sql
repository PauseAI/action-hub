-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "request_id" INTEGER;

-- CreateIndex
CREATE INDEX "idx_calls_request" ON "calls"("request_id");

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

