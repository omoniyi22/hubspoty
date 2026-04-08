"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncService = void 0;
// src/services/sync.service.ts
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
            if (syncRecord) {
                // ✅ EXISTING CONTACT: Always update by stored HubSpot contact ID.
                // Never call createOrUpdateContact here — that searches by the NEW
                // email and misses the old contact, creating a duplicate.
                console.log(`🔄 [Wix→HubSpot] Updating existing contact by ID: ${syncRecord.hubSpotContactId}`);
                await this.hubspotService.updateContact(connectionId, syncRecord.hubSpotContactId, hubSpotData);
                await database_1.prisma.contactSync.update({
                    where: { id: syncRecord.id },
                    data: {
                        lastSyncedAt: new Date(),
                        lastSyncDirection: 'wix_to_hubspot',
                        syncSource: 'wix',
                        correlationId: syncCorrelationId,
                        wixVersion: wixContactData.version ?? 0,
                        updatedAt: new Date(),
                    },
                });
                await this.createSyncLogWithRetry({
                    connectionId,
                    syncType: 'contact_update',
                    direction: 'wix_to_hubspot',
                    status: 'success',
                    wixContactId,
                    hubSpotContactId: syncRecord.hubSpotContactId,
                    correlationId: syncCorrelationId,
                    requestData: hubSpotData,
                    responseData: { id: syncRecord.hubSpotContactId, isNew: false },
                });
                console.log(`✅ [Wix→HubSpot] Contact updated via stored HubSpot ID`);
            }
            else {
                // ✅ NO SYNC RECORD: Genuinely new contact — safe to search by email
                // then create if not found.
                console.log(`🆕 [Wix→HubSpot] No sync record — checking HubSpot by email then creating`);
                const result = await this.hubspotService.createOrUpdateContact(connectionId, hubSpotData.email, hubSpotData);
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
                console.log(`✅ [Wix→HubSpot] New contact ${result.isNew ? 'created' : 'matched and updated'}`);
            }
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
        // Loop prevention for HubSpot → Wix sync
        const recentWixToHubspotSync = await database_1.prisma.syncLog.findFirst({
            where: {
                connectionId: connectionId,
                hubSpotContactId: hubSpotContactId,
                direction: 'wix_to_hubspot',
                status: 'success',
                createdAt: { gte: new Date(Date.now() - 60000) },
            },
        });
        if (recentWixToHubspotSync) {
            console.log(`🛡️ Loop prevention: skipping HubSpot to Wix sync - recently synced FROM Wix`, {
                hubSpotContactId,
                secondsAgo: (Date.now() - recentWixToHubspotSync.createdAt.getTime()) / 1000
            });
            return;
        }
        try {
            const email = hubSpotContactData.properties?.email;
            if (!email) {
                throw new Error('Email is required for Wix contact sync');
            }
            console.log('[Sync] Starting HubSpot to Wix sync', {
                hubSpotContactId,
                email,
                connectionId
            });
            let existingWixContact = await this.wixService.queryContactByEmail(connectionId, email);
            const wixData = await this.transformHubSpotToWix(connectionId, hubSpotContactData);
            const rawTimestamp = hubSpotContactData.properties?.hs_updatedate;
            const hubSpotVersion = rawTimestamp
                ? Math.min(parseFloat(rawTimestamp), Number.MAX_SAFE_INTEGER)
                : 0;
            const syncRecord = await database_1.prisma.contactSync.findUnique({
                where: {
                    connectionId_hubSpotContactId: { connectionId, hubSpotContactId }
                }
            });
            let finalWixContactId;
            let isNewMapping = false;
            if (existingWixContact) {
                // Check if this Wix contact is already linked to a DIFFERENT HubSpot contact
                const existingWixLink = await database_1.prisma.contactSync.findUnique({
                    where: {
                        connectionId_wixContactId: {
                            connectionId,
                            wixContactId: existingWixContact.id
                        }
                    }
                });
                if (existingWixLink && existingWixLink.hubSpotContactId !== hubSpotContactId) {
                    console.warn('[Sync] Wix contact linked to different HubSpot - REASSIGNING link', {
                        wixContactId: existingWixContact.id,
                        oldHubSpotId: existingWixLink.hubSpotContactId,
                        newHubSpotId: hubSpotContactId
                    });
                    await database_1.prisma.contactSync.delete({
                        where: { id: existingWixLink.id }
                    });
                    const existingNewHubSpotLink = await database_1.prisma.contactSync.findUnique({
                        where: {
                            connectionId_hubSpotContactId: {
                                connectionId,
                                hubSpotContactId: hubSpotContactId
                            }
                        }
                    });
                    if (existingNewHubSpotLink) {
                        console.warn('[Sync] New HubSpot contact already linked to different Wix - deleting old link', {
                            hubSpotContactId,
                            oldWixId: existingNewHubSpotLink.wixContactId
                        });
                        await database_1.prisma.contactSync.delete({
                            where: { id: existingNewHubSpotLink.id }
                        });
                    }
                    await database_1.prisma.contactSync.create({
                        data: {
                            connectionId,
                            wixContactId: existingWixContact.id,
                            hubSpotContactId: hubSpotContactId,
                            lastSyncedAt: new Date(),
                            lastSyncDirection: 'hubspot_to_wix',
                            syncSource: 'hubspot',
                            correlationId: syncCorrelationId,
                            hubSpotVersion,
                        }
                    });
                }
                console.log('[Sync] Found existing Wix contact by EMAIL — updating', {
                    email,
                    wixContactId: existingWixContact.id,
                    hubSpotContactId
                });
                await this.wixService.updateContact(connectionId, existingWixContact.id, wixData);
                finalWixContactId = existingWixContact.id;
            }
            else if (syncRecord) {
                const existingWixLink = await database_1.prisma.contactSync.findUnique({
                    where: {
                        connectionId_wixContactId: {
                            connectionId,
                            wixContactId: syncRecord.wixContactId
                        }
                    }
                });
                if (existingWixLink && existingWixLink.hubSpotContactId !== hubSpotContactId) {
                    console.warn('[Sync] Stored Wix ID linked to different HubSpot - REASSIGNING', {
                        oldWixId: syncRecord.wixContactId,
                        conflictingHubSpotId: existingWixLink.hubSpotContactId
                    });
                    await database_1.prisma.contactSync.delete({
                        where: { id: existingWixLink.id }
                    });
                    await database_1.prisma.contactSync.delete({
                        where: { id: syncRecord.id }
                    });
                    await database_1.prisma.contactSync.create({
                        data: {
                            connectionId,
                            wixContactId: existingWixLink.wixContactId,
                            hubSpotContactId: hubSpotContactId,
                            lastSyncedAt: new Date(),
                            lastSyncDirection: 'hubspot_to_wix',
                            syncSource: 'hubspot',
                            correlationId: syncCorrelationId,
                            hubSpotVersion,
                        }
                    });
                    await this.wixService.updateContact(connectionId, existingWixLink.wixContactId, wixData);
                    finalWixContactId = existingWixLink.wixContactId;
                }
                else {
                    console.log('[Sync] Using stored Wix ID from sync record', {
                        wixContactId: syncRecord.wixContactId,
                        hubSpotContactId
                    });
                    await this.wixService.updateContact(connectionId, syncRecord.wixContactId, wixData);
                    finalWixContactId = syncRecord.wixContactId;
                    await database_1.prisma.contactSync.update({
                        where: { id: syncRecord.id },
                        data: {
                            lastSyncedAt: new Date(),
                            lastSyncDirection: 'hubspot_to_wix',
                            syncSource: 'hubspot',
                            correlationId: syncCorrelationId,
                            hubSpotVersion,
                            updatedAt: new Date(),
                        },
                    });
                }
            }
            else {
                // Truly new contact — create in Wix
                console.log('[Sync] Creating NEW Wix contact', { email, hubSpotContactId });
                const newWixContact = await this.wixService.createContact(connectionId, wixData);
                finalWixContactId = newWixContact.id;
                isNewMapping = true;
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
    async createSyncLogWithRetry(data, maxRetries = 3) {
        let lastError = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await database_1.prisma.syncLog.create({ data });
                return;
            }
            catch (error) {
                lastError = error;
                if (error.code === 'P1017' || error.message?.includes('connection')) {
                    console.log(`[Sync] Database connection error, retrying sync log creation (attempt ${attempt}/${maxRetries})`);
                    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    try {
                        await database_1.prisma.$disconnect();
                        await database_1.prisma.$connect();
                    }
                    catch (connError) {
                        console.error('[Sync] Failed to reconnect to database', connError);
                    }
                }
                else {
                    console.error('[Sync] Failed to create sync log (non-retryable error)', error);
                    throw error;
                }
            }
        }
        console.error('[Sync] CRITICAL: Failed to create sync log after all retries', {
            data,
            lastError: lastError?.message
        });
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
    }
}
exports.SyncService = SyncService;
//# sourceMappingURL=sync.service.js.map