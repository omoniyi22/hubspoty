"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncService = void 0;
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
        // This is kept for backward compatibility
        // New code should use mappingService.updateMappingRules
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
            await database_1.prisma.syncLog.create({
                data: {
                    connectionId,
                    syncType: result.isNew ? 'contact_create' : 'contact_update',
                    direction: 'wix_to_hubspot',
                    status: 'success',
                    wixContactId,
                    hubSpotContactId: result.id,
                    correlationId: syncCorrelationId,
                    requestData: hubSpotData,
                    responseData: { id: result.id, isNew: result.isNew },
                },
            });
        }
        catch (error) {
            await database_1.prisma.syncLog.create({
                data: {
                    connectionId,
                    syncType: 'contact_update',
                    direction: 'wix_to_hubspot',
                    status: 'failed',
                    wixContactId,
                    correlationId: syncCorrelationId,
                    errorMessage: error instanceof Error ? error.message : 'Unknown error',
                },
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
            const syncRecord = await database_1.prisma.contactSync.findUnique({
                where: {
                    connectionId_hubSpotContactId: { connectionId, hubSpotContactId }
                }
            });
            const wixData = await this.transformHubSpotToWix(connectionId, hubSpotContactData);
            if (!wixData.email) {
                throw new Error('Email is required for Wix contact');
            }
            const rawTimestamp = hubSpotContactData.properties.hs_updatedate;
            const hubSpotVersion = rawTimestamp
                ? Math.min(parseFloat(rawTimestamp), Number.MAX_SAFE_INTEGER)
                : 0;
            if (syncRecord) {
                await this.wixService.updateContact(connectionId, syncRecord.wixContactId, wixData);
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
            else {
                const newWixContact = await this.wixService.createContact(connectionId, wixData);
                await database_1.prisma.contactSync.create({
                    data: {
                        connectionId,
                        wixContactId: newWixContact.id,
                        hubSpotContactId,
                        lastSyncedAt: new Date(),
                        lastSyncDirection: 'hubspot_to_wix',
                        syncSource: 'hubspot',
                        correlationId: syncCorrelationId,
                        hubSpotVersion,
                    },
                });
            }
            await database_1.prisma.syncLog.create({
                data: {
                    connectionId,
                    syncType: syncRecord ? 'contact_update' : 'contact_create',
                    direction: 'hubspot_to_wix',
                    status: 'success',
                    wixContactId: syncRecord?.wixContactId,
                    hubSpotContactId,
                    correlationId: syncCorrelationId,
                    requestData: wixData,
                    responseData: { success: true },
                },
            });
        }
        catch (error) {
            await database_1.prisma.syncLog.create({
                data: {
                    connectionId,
                    syncType: 'contact_update',
                    direction: 'hubspot_to_wix',
                    status: 'failed',
                    hubSpotContactId,
                    correlationId: syncCorrelationId,
                    errorMessage: error instanceof Error ? error.message : 'Unknown error',
                },
            });
            throw error;
        }
    }
}
exports.SyncService = SyncService;
//# sourceMappingURL=sync.service.js.map