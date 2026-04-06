-- CreateTable
CREATE TABLE "HubSpotConnection" (
    "id" TEXT NOT NULL,
    "wixInstanceId" TEXT NOT NULL,
    "hubSpotPortalId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL,
    "isConnected" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubSpotConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldMapping" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "mappings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactSync" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "wixContactId" TEXT NOT NULL,
    "hubSpotContactId" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncDirection" TEXT NOT NULL,
    "syncSource" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "wixVersion" INTEGER NOT NULL DEFAULT 0,
    "hubSpotVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "wixFormId" TEXT NOT NULL,
    "hubSpotContactId" TEXT NOT NULL,
    "formData" JSONB NOT NULL,
    "utmParams" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedToHubSpot" BOOLEAN NOT NULL DEFAULT true,
    "hubSpotSubmissionId" TEXT,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "syncType" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "wixContactId" TEXT,
    "hubSpotContactId" TEXT,
    "requestData" JSONB,
    "responseData" JSONB,
    "errorMessage" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HubSpotConnection_wixInstanceId_key" ON "HubSpotConnection"("wixInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldMapping_connectionId_key" ON "FieldMapping"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactSync_correlationId_key" ON "ContactSync"("correlationId");

-- CreateIndex
CREATE INDEX "ContactSync_wixContactId_idx" ON "ContactSync"("wixContactId");

-- CreateIndex
CREATE INDEX "ContactSync_hubSpotContactId_idx" ON "ContactSync"("hubSpotContactId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactSync_connectionId_wixContactId_key" ON "ContactSync"("connectionId", "wixContactId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactSync_connectionId_hubSpotContactId_key" ON "ContactSync"("connectionId", "hubSpotContactId");

-- CreateIndex
CREATE INDEX "FormSubmission_connectionId_idx" ON "FormSubmission"("connectionId");

-- CreateIndex
CREATE INDEX "FormSubmission_submittedAt_idx" ON "FormSubmission"("submittedAt");

-- CreateIndex
CREATE INDEX "FormSubmission_hubSpotContactId_idx" ON "FormSubmission"("hubSpotContactId");

-- CreateIndex
CREATE INDEX "SyncLog_connectionId_idx" ON "SyncLog"("connectionId");

-- CreateIndex
CREATE INDEX "SyncLog_createdAt_idx" ON "SyncLog"("createdAt");

-- CreateIndex
CREATE INDEX "SyncLog_status_idx" ON "SyncLog"("status");

-- AddForeignKey
ALTER TABLE "FieldMapping" ADD CONSTRAINT "FieldMapping_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "HubSpotConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactSync" ADD CONSTRAINT "ContactSync_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "HubSpotConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "HubSpotConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "HubSpotConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
