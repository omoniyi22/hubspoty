import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { HubSpotService } from './hubspot.service';
import { WixService } from './wix.service';
import { MappingService } from './mapping.service';
import { FieldMappingConfig, WixContact, HubSpotContact } from '../types';

export class SyncService {
  private static instance: SyncService;
  private hubspotService = HubSpotService.getInstance();
  private wixService = WixService.getInstance();
  private mappingService = MappingService.getInstance();

  static getInstance(): SyncService {
    if (!SyncService.instance) {
      SyncService.instance = new SyncService();
    }
    return SyncService.instance;
  }

  async getFieldMapping(connectionId: string): Promise<FieldMappingConfig> {
    return this.mappingService.getFieldMapping(connectionId);
  }

  async updateFieldMapping(
    connectionId: string,
    mappings: FieldMappingConfig
  ): Promise<void> {
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

  async transformWixToHubSpot(
    connectionId: string,
    wixContact: WixContact
  ): Promise<Record<string, any>> {
    return this.mappingService.transformWixToHubSpot(connectionId, wixContact);
  }

  async transformHubSpotToWix(
    connectionId: string,
    hubSpotContact: HubSpotContact
  ): Promise<Record<string, any>> {
    const hubSpotData = hubSpotContact.properties || hubSpotContact;
    return this.mappingService.transformHubSpotToWix(connectionId, hubSpotData);
  }

  async syncWixContactToHubSpot(
    connectionId: string,
    wixContactId: string,
    wixContactData: WixContact,
    correlationId?: string
  ): Promise<void> {
    const syncCorrelationId = correlationId || uuidv4();

    if (correlationId) {
      const existingSync = await prisma.contactSync.findFirst({
        where: { connectionId, correlationId }
      });

      if (existingSync) {
        console.log(`🛡️ Duplicate sync detected by correlationId: ${correlationId}`);
        return;
      }
    }

    try {
      const syncRecord = await prisma.contactSync.findUnique({
        where: {
          connectionId_wixContactId: { connectionId, wixContactId }
        }
      });

      if (
        syncRecord &&
        wixContactData.version !== undefined &&
        syncRecord.wixVersion >= wixContactData.version
      ) {
        console.log(
          `🛡️ Skipping older version: ${wixContactData.version} <= ${syncRecord.wixVersion}`
        );
        return;
      }

      const hubSpotData = await this.transformWixToHubSpot(connectionId, wixContactData);

      if (!hubSpotData.email) {
        throw new Error('Email is required for HubSpot contact');
      }

      const result = await this.hubspotService.createOrUpdateContact(
        connectionId,
        hubSpotData.email,
        hubSpotData
      );

      if (syncRecord) {
        await prisma.contactSync.update({
          where: { id: syncRecord.id },
          data: {
            hubSpotContactId:  result.id,
            lastSyncedAt:      new Date(),
            lastSyncDirection: 'wix_to_hubspot',
            syncSource:        'wix',
            correlationId:     syncCorrelationId,
            wixVersion:        wixContactData.version ?? 0,
            updatedAt:         new Date(),
          },
        });
      } else {
        await prisma.contactSync.create({
          data: {
            connectionId,
            wixContactId,
            hubSpotContactId:  result.id,
            lastSyncedAt:      new Date(),
            lastSyncDirection: 'wix_to_hubspot',
            syncSource:        'wix',
            correlationId:     syncCorrelationId,
            wixVersion:        wixContactData.version ?? 0,
          },
        });
      }

      await prisma.syncLog.create({
        data: {
          connectionId,
          syncType:        result.isNew ? 'contact_create' : 'contact_update',
          direction:       'wix_to_hubspot',
          status:          'success',
          wixContactId,
          hubSpotContactId: result.id,
          correlationId:    syncCorrelationId,
          requestData:     hubSpotData,
          responseData:    { id: result.id, isNew: result.isNew },
        },
      });

    } catch (error) {
      await prisma.syncLog.create({
        data: {
          connectionId,
          syncType:      'contact_update',
          direction:     'wix_to_hubspot',
          status:        'failed',
          wixContactId,
          correlationId: syncCorrelationId,
          errorMessage:  error instanceof Error ? error.message : 'Unknown error',
        },
      });
      throw error;
    }
  }

  async syncHubSpotContactToWix(
    connectionId: string,
    hubSpotContactId: string,
    hubSpotContactData: HubSpotContact,
    correlationId?: string
  ): Promise<void> {
    const syncCorrelationId = correlationId || uuidv4();

    if (correlationId) {
      const existingSync = await prisma.contactSync.findFirst({
        where: { connectionId, correlationId }
      });

      if (existingSync) {
        console.log(`🛡️ Duplicate sync detected by correlationId: ${correlationId}`);
        return;
      }
    }

    try {
      const syncRecord = await prisma.contactSync.findUnique({
        where: {
          connectionId_hubSpotContactId: { connectionId, hubSpotContactId }
        }
      });

      const wixData = await this.transformHubSpotToWix(connectionId, hubSpotContactData);

      if (!wixData.email) {
        throw new Error('Email is required for Wix contact');
      }

      const rawTimestamp  = hubSpotContactData.properties.hs_updatedate;
      const hubSpotVersion = rawTimestamp
        ? Math.min(parseFloat(rawTimestamp), Number.MAX_SAFE_INTEGER)
        : 0;

      if (syncRecord) {
        await this.wixService.updateContact(
          connectionId,
          syncRecord.wixContactId,
          wixData
        );

        await prisma.contactSync.update({
          where: { id: syncRecord.id },
          data: {
            lastSyncedAt:      new Date(),
            lastSyncDirection: 'hubspot_to_wix',
            syncSource:        'hubspot',
            correlationId:     syncCorrelationId,
            hubSpotVersion,
            updatedAt:         new Date(),
          },
        });
      } else {
        const newWixContact = await this.wixService.createContact(connectionId, wixData);

        await prisma.contactSync.create({
          data: {
            connectionId,
            wixContactId:      newWixContact.id,
            hubSpotContactId,
            lastSyncedAt:      new Date(),
            lastSyncDirection: 'hubspot_to_wix',
            syncSource:        'hubspot',
            correlationId:     syncCorrelationId,
            hubSpotVersion,
          },
        });
      }

      await prisma.syncLog.create({
        data: {
          connectionId,
          syncType:        syncRecord ? 'contact_update' : 'contact_create',
          direction:       'hubspot_to_wix',
          status:          'success',
          wixContactId:    syncRecord?.wixContactId,
          hubSpotContactId,
          correlationId:   syncCorrelationId,
          requestData:     wixData,
          responseData:    { success: true },
        },
      });

    } catch (error) {
      await prisma.syncLog.create({
        data: {
          connectionId,
          syncType:        'contact_update',
          direction:       'hubspot_to_wix',
          status:          'failed',
          hubSpotContactId,
          correlationId:   syncCorrelationId,
          errorMessage:    error instanceof Error ? error.message : 'Unknown error',
        },
      });
      throw error;
    }
  }
}