-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN     "leadScore" INTEGER DEFAULT 0,
ADD COLUMN     "leadStatus" TEXT DEFAULT 'new',
ADD COLUMN     "pageUrl" TEXT,
ADD COLUMN     "referrer" TEXT,
ADD COLUMN     "utmCampaign" TEXT,
ADD COLUMN     "utmContent" TEXT,
ADD COLUMN     "utmMedium" TEXT,
ADD COLUMN     "utmSource" TEXT,
ADD COLUMN     "utmTerm" TEXT,
ADD COLUMN     "wixFormName" TEXT;

-- CreateIndex
CREATE INDEX "FormSubmission_utmSource_idx" ON "FormSubmission"("utmSource");

-- CreateIndex
CREATE INDEX "FormSubmission_utmCampaign_idx" ON "FormSubmission"("utmCampaign");

-- CreateIndex
CREATE INDEX "FormSubmission_leadStatus_idx" ON "FormSubmission"("leadStatus");
