"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncService = void 0;
// src/services/sync.service.ts - COMPLETE FIXED VERSION
const uuid_1 = require("uuid");
const database_1 = require("../config/database");
const hubspot_service_1 = require("./hubspot.service");
const wix_service_1 = require("./wix.service");
const mapping_service_1 = require("./mapping.service");
class SyncService {
    constructor() {
        this.hubspotService = hubspot_service_1.HubSpotService.getInstance();
        this.wixService = wix_service_1.WixService.getInstance();
        this.mappingService = mapping_service_1.MappingService.getInstance();
    }
    static getInstance() {
        if (!SyncService.instance) {
            SyncService.instance = new SyncService();
        }
        return SyncService.instance;
    }
    async getFieldMapping(connectionId) {
        return this.mappingService.getFieldMapping(connectionId);
    }
    async updateFieldMapping(connectionId, mappings) {
        const updates = mappings.mappings.map(m => ({
            wixField: m.wixField,
            direction: m.direction,
            transform: m.transform || null,
            isActive: true,
        }));
        await this.mappingService.updateMappingRules(connectionId, updates);
    }
    async transformWixToHubSpot(connectionId, wixContact) {
        return this.mappingService.transformWixToHubSpot(connectionId, wixContact);
    }
    async transformHubSpotToWix(connectionId, hubSpotContact) {
        const hubSpotData = hubSpotContact.properties || hubSpotContact;
        return this.mappingService.transformHubSpotToWix(connectionId, hubSpotData);
    }
    async syncWixContactToHubSpot(connectionId, wixContactId, wixContactData, correlationId) {
        const syncCorrelationId = correlationId || (0, uuid_1.v4)();
        if (correlationId) {
            const existingSync = await database_1.prisma.contactSync.findFirst({
                where: { connectionId, correlationId }
            });
            if (existingSync) {
                console.log(`🛡️ Duplicate sync detected by correlationId: ${correlationId}`);
                return;
            }
        }
        try {
            const syncRecord = await database_1.prisma.contactSync.findUnique({
                where: {
                    connectionId_wixContactId: { connectionId, wixContactId }
                }
            });
            if (syncRecord &&
                wixContactData.version !== undefined &&
                syncRecord.wixVersion >= wixContactData.version) {
                console.log(`🛡️ Skipping older version: ${wixContactData.version} <= ${syncRecord.wixVersion}`);
                return;
            }
            const hubSpotData = await this.transformWixToHubSpot(connectionId, wixContactData);
            if (!hubSpotData.email) {
                throw new Error('Email is required for HubSpot contact');
            }
            const result = await this.hubspotService.createOrUpdateContact(connectionId, hubSpotData.email, hubSpotData);
            if (syncRecord) {
                await database_1.prisma.contactSync.update({
                    where: { id: syncRecord.id },
                    data: {
                        hubSpotContactId: result.id,
                        lastSyncedAt: new Date(),
                        lastSyncDirection: 'wix_to_hubspot',
                        syncSource: 'wix',
                        correlationId: syncCorrelationId,
                        wixVersion: wixContactData.version ?? 0,
                        updatedAt: new Date(),
                    },
                });
            }
            else {
                await database_1.prisma.contactSync.create({
                    data: {
                        connectionId,
                        wixContactId,
                        hubSpotContactId: result.id,
                        lastSyncedAt: new Date(),
                        lastSyncDirection: 'wix_to_hubspot',
                        syncSource: 'wix',
                        correlationId: syncCorrelationId,
                        wixVersion: wixContactData.version ?? 0,
                    },
                });
            }
            await this.createSyncLogWithRetry({
                connectionId,
                syncType: result.isNew ? 'contact_create' : 'contact_update',
                direction: 'wix_to_hubspot',
                status: 'success',
                wixContactId,
                hubSpotContactId: result.id,
                correlationId: syncCorrelationId,
                requestData: hubSpotData,
                responseData: { id: result.id, isNew: result.isNew },
            });
        }
        catch (error) {
            await this.createSyncLogWithRetry({
                connectionId,
                syncType: 'contact_update',
                direction: 'wix_to_hubspot',
                status: 'failed',
                wixContactId,
                correlationId: syncCorrelationId,
                errorMessage: error instanceof Error ? error.message : 'Unknown error',
            });
            throw error;
        }
    }
    async syncHubSpotContactToWix(connectionId, hubSpotContactId, hubSpotContactData, correlationId) {
        const syncCorrelationId = correlationId || (0, uuid_1.v4)();
        if (correlationId) {
            const existingSync = await database_1.prisma.contactSync.findFirst({
                where: { connectionId, correlationId }
            });
            if (existingSync) {
                console.log(`🛡️ Duplicate sync detected by correlationId: ${correlationId}`);
                return;
            }
        }
        try {
            // CRITICAL FIX: Get email from HubSpot contact first
            const email = hubSpotContactData.properties?.email;
            if (!email) {
                throw new Error('Email is required for Wix contact sync');
            }
            console.log('[Sync] Starting HubSpot to Wix sync', {
                hubSpotContactId,
                email,
                connectionId
            });
            // STEP 1: ALWAYS query Wix by email first to find existing contact
            let existingWixContact = await this.wixService.queryContactByEmail(connectionId, email);
            // STEP 2: Transform the data
            const wixData = await this.transformHubSpotToWix(connectionId, hubSpotContactData);
            // STEP 3: Get version info
            const rawTimestamp = hubSpotContactData.properties?.hs_updatedate;
            const hubSpotVersion = rawTimestamp
                ? Math.min(parseFloat(rawTimestamp), Number.MAX_SAFE_INTEGER)
                : 0;
            // STEP 4: Check for existing sync record
            const syncRecord = await database_1.prisma.contactSync.findUnique({
                where: {
                    connectionId_hubSpotContactId: { connectionId, hubSpotContactId }
                }
            });
            let finalWixContactId;
            let isNewMapping = false;
            if (existingWixContact) {
                // FOUND BY EMAIL - Update this contact
                console.log('[Sync] Found existing Wix contact by EMAIL', {
                    email,
                    wixContactId: existingWixContact.id,
                    hubSpotContactId
                });
                await this.wixService.updateContact(connectionId, existingWixContact.id, wixData);
                finalWixContactId = existingWixContact.id;
                // Update sync record if it exists with wrong ID
                if (syncRecord && syncRecord.wixContactId !== existingWixContact.id) {
                    console.log('[Sync] Updating sync record with correct Wix ID', {
                        oldWixId: syncRecord.wixContactId,
                        newWixId: existingWixContact.id
                    });
                    await database_1.prisma.contactSync.update({
                        where: { id: syncRecord.id },
                        data: { wixContactId: existingWixContact.id }
                    });
                }
            }
            else if (syncRecord) {
                // Have sync record but no email match - use stored Wix ID
                console.log('[Sync] Using stored Wix ID from sync record', {
                    wixContactId: syncRecord.wixContactId,
                    hubSpotContactId
                });
                await this.wixService.updateContact(connectionId, syncRecord.wixContactId, wixData);
                finalWixContactId = syncRecord.wixContactId;
            }
            else {
                // No existing contact anywhere - create new
                console.log('[Sync] Creating NEW Wix contact', { email, hubSpotContactId });
                const newWixContact = await this.wixService.createContact(connectionId, wixData);
                finalWixContactId = newWixContact.id;
                isNewMapping = true;
            }
            // STEP 5: Upsert the contact sync record
            if (syncRecord) {
                await database_1.prisma.contactSync.update({
                    where: { id: syncRecord.id },
                    data: {
                        lastSyncedAt: new Date(),
                        lastSyncDirection: 'hubspot_to_wix',
                        syncSource: 'hubspot',
                        correlationId: syncCorrelationId,
                        hubSpotVersion,
                        wixContactId: finalWixContactId,
                        updatedAt: new Date(),
                    },
                });
            }
            else {
                await database_1.prisma.contactSync.create({
                    data: {
                        connectionId,
                        wixContactId: finalWixContactId,
                        hubSpotContactId,
                        lastSyncedAt: new Date(),
                        lastSyncDirection: 'hubspot_to_wix',
                        syncSource: 'hubspot',
                        correlationId: syncCorrelationId,
                        hubSpotVersion,
                    },
                });
            }
            // STEP 6: Log success
            await this.createSyncLogWithRetry({
                connectionId,
                syncType: (syncRecord || isNewMapping) ? 'contact_update' : 'contact_create',
                direction: 'hubspot_to_wix',
                status: 'success',
                wixContactId: finalWixContactId,
                hubSpotContactId,
                correlationId: syncCorrelationId,
                requestData: wixData,
                responseData: { success: true, foundByEmail: !!existingWixContact },
            });
            console.log('[Sync] Successfully synced HubSpot contact to Wix', {
                hubSpotContactId,
                wixContactId: finalWixContactId,
                foundByEmail: !!existingWixContact
            });
        }
        catch (error) {
            console.error('[Sync] Failed to sync HubSpot contact to Wix', {
                hubSpotContactId,
                connectionId,
                error: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined
            });
            await this.createSyncLogWithRetry({
                connectionId,
                syncType: 'contact_update',
                direction: 'hubspot_to_wix',
                status: 'failed',
                hubSpotContactId,
                correlationId: syncCorrelationId,
                errorMessage: error instanceof Error ? error.message : 'Unknown error',
            });
            throw error;
        }
    }
    // Helper method to create sync log with retry logic for database connection issues
    async createSyncLogWithRetry(data, maxRetries = 3) {
        let lastError = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await database_1.prisma.syncLog.create({ data });
                return;
            }
            catch (error) {
                lastError = error;
                // Check if it's a database connection error
                if (error.code === 'P1017' || error.message?.includes('connection')) {
                    console.log(`[Sync] Database connection error, retrying sync log creation (attempt ${attempt}/${maxRetries})`);
                    // Exponential backoff
                    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    // Attempt to reconnect
                    try {
                        await database_1.prisma.$disconnect();
                        await database_1.prisma.$connect();
                    }
                    catch (connError) {
                        console.error('[Sync] Failed to reconnect to database', connError);
                    }
                }
                else {
                    // Non-connection error, log but don't retry
                    console.error('[Sync] Failed to create sync log (non-retryable error)', error);
                    throw error;
                }
            }
        }
        // If we get here, all retries failed
        console.error('[Sync] CRITICAL: Failed to create sync log after all retries', {
            data,
            lastError: lastError?.message
        });
        // Fallback: write to console/file
        const fs = require('fs');
        const logEntry = {
            timestamp: new Date().toISOString(),
            ...data,
            error: lastError?.message
        };
        try {
            fs.appendFileSync('sync-log-failures.json', JSON.stringify(logEntry) + '\n');
        }
        catch (fsError) {
            console.error('[Sync] Failed to write fallback log', fsError);
        }
        // Don't throw - we don't want to fail the sync just because logging failed
    }
}
exports.SyncService = SyncService;
//# sourceMappingURL=sync.service.js.map