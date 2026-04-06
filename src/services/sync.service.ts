// src/services/sync.service.ts
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { HubSpotService } from './hubspot.service';
import { WixService } from './wix.service';
import { FieldMappingConfig, WixContact, HubSpotContact } from '../types';

export class SyncService {
  private static instance: SyncService;
  private hubspotService = HubSpotService.getInstance();
  private wixService = WixService.getInstance();

  static getInstance(): SyncService {
    if (!SyncService.instance) {
      SyncService.instance = new SyncService();
    }
    return SyncService.instance;
  }

  async getFieldMapping(connectionId: string): Promise<FieldMappingConfig> {
    const mapping = await prisma.fieldMapping.findUnique({
      where: { connectionId }
    });

    if (!mapping) {
      // Return default mapping
      return {
        mappings: [
          { wixField: 'email', hubSpotProperty: 'email', direction: 'bidirectional' },
          { wixField: 'firstName', hubSpotProperty: 'firstname', direction: 'bidirectional' },
          { wixField: 'lastName', hubSpotProperty: 'lastname', direction: 'bidirectional' },
          { wixField: 'phone', hubSpotProperty: 'phone', direction: 'bidirectional' }
        ]
      };
    }

    return mapping.mappings as any;
  }

  async updateFieldMapping(connectionId: string, mappings: FieldMappingConfig): Promise<void> {
    await prisma.fieldMapping.upsert({
      where: { connectionId },
      update: { mappings: mappings as any },
      create: { connectionId, mappings: mappings as any }
    });
  }

  async transformWixToHubSpot(connectionId: string, wixContact: WixContact): Promise<Record<string, any>> {
    const mapping = await this.getFieldMapping(connectionId);
    const hubSpotData: Record<string, any> = {};

    for (const map of mapping.mappings) {
      if (map.direction === 'wix_to_hubspot' || map.direction === 'bidirectional') {
        let value = wixContact[map.wixField as keyof WixContact];
        
        if (value && map.transform) {
          switch (map.transform) {
            case 'trim':
              value = typeof value === 'string' ? value.trim() : value;
              break;
            case 'lowercase':
              value = typeof value === 'string' ? value.toLowerCase() : value;
              break;
            case 'uppercase':
              value = typeof value === 'string' ? value.toUpperCase() : value;
              break;
            case 'email':
              value = typeof value === 'string' ? value.toLowerCase().trim() : value;
              break;
          }
        }
        
        if (value) {
          hubSpotData[map.hubSpotProperty] = value;
        }
      }
    }

    return hubSpotData;
  }

  async transformHubSpotToWix(connectionId: string, hubSpotContact: HubSpotContact): Promise<Record<string, any>> {
    const mapping = await this.getFieldMapping(connectionId);
    const wixData: Record<string, any> = {};

    for (const map of mapping.mappings) {
      if (map.direction === 'hubspot_to_wix' || map.direction === 'bidirectional') {
        let value = hubSpotContact.properties[map.hubSpotProperty];
        
        if (value && map.transform) {
          switch (map.transform) {
            case 'trim':
              value = typeof value === 'string' ? value.trim() : value;
              break;
            case 'lowercase':
              value = typeof value === 'string' ? value.toLowerCase() : value;
              break;
            case 'uppercase':
              value = typeof value === 'string' ? value.toUpperCase() : value;
              break;
          }
        }
        
        if (value) {
          wixData[map.wixField] = value;
        }
      }
    }

    return wixData;
  }

  async syncWixContactToHubSpot(
    connectionId: string,
    wixContactId: string,
    wixContactData: WixContact,
    correlationId?: string
  ): Promise<void> {
    const syncCorrelationId = correlationId || uuidv4();
    
    try {
      // Check if we've already processed this event
      const existingSync = await prisma.contactSync.findFirst({
        where: {
          connectionId,
          correlationId: syncCorrelationId
        }
      });

      if (existingSync) {
        console.log(`Duplicate sync detected: ${syncCorrelationId}`);
        return;
      }

      // Get existing sync record
      let syncRecord = await prisma.contactSync.findUnique({
        where: {
          connectionId_wixContactId: {
            connectionId,
            wixContactId
          }
        }
      });

      // Check version to prevent race conditions
      if (syncRecord && wixContactData.version && syncRecord.wixVersion >= wixContactData.version) {
        console.log(`Skipping older version: ${wixContactData.version} <= ${syncRecord.wixVersion}`);
        return;
      }

      // Transform data
      const hubSpotData = await this.transformWixToHubSpot(connectionId, wixContactData);

      if (!hubSpotData.email) {
        throw new Error('Email is required for HubSpot contact');
      }

      // Create or update in HubSpot
      const result = await this.hubspotService.createOrUpdateContact(
        connectionId,
        hubSpotData.email,
        hubSpotData
      );

      // Update or create sync record
      if (syncRecord) {
        await prisma.contactSync.update({
          where: { id: syncRecord.id },
          data: {
            hubSpotContactId: result.id,
            lastSyncedAt: new Date(),
            lastSyncDirection: 'wix_to_hubspot',
            syncSource: 'wix',
            correlationId: syncCorrelationId,
            wixVersion: wixContactData.version || 0,
            updatedAt: new Date()
          }
        });
      } else {
        await prisma.contactSync.create({
          data: {
            connectionId,
            wixContactId,
            hubSpotContactId: result.id,
            lastSyncedAt: new Date(),
            lastSyncDirection: 'wix_to_hubspot',
            syncSource: 'wix',
            correlationId: syncCorrelationId,
            wixVersion: wixContactData.version || 0
          }
        });
      }

      // Log success
      await prisma.syncLog.create({
        data: {
          connectionId,
          syncType: result.isNew ? 'contact_create' : 'contact_update',
          direction: 'wix_to_hubspot',
          status: 'success',
          wixContactId,
          hubSpotContactId: result.id,
          correlationId: syncCorrelationId
        }
      });

    } catch (error) {
      // Log error
      await prisma.syncLog.create({
        data: {
          connectionId,
          syncType: 'contact_update',
          direction: 'wix_to_hubspot',
          status: 'failed',
          wixContactId,
          correlationId: syncCorrelationId,
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        }
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
    
    try {
      // Check if we've already processed this event
      const existingSync = await prisma.contactSync.findFirst({
        where: {
          connectionId,
          correlationId: syncCorrelationId
        }
      });

      if (existingSync) {
        console.log(`Duplicate sync detected: ${syncCorrelationId}`);
        return;
      }

      // Get existing sync record
      let syncRecord = await prisma.contactSync.findUnique({
        where: {
          connectionId_hubSpotContactId: {
            connectionId,
            hubSpotContactId
          }
        }
      });

      // Transform data
      const wixData = await this.transformHubSpotToWix(connectionId, hubSpotContactData);

      if (!wixData.email) {
        throw new Error('Email is required for Wix contact');
      }

      // Create or update in Wix
      if (syncRecord) {
        await this.wixService.updateContact(connectionId, syncRecord.wixContactId, wixData);
      } else {
        const newWixContact = await this.wixService.createContact(connectionId, wixData);
        
        await prisma.contactSync.create({
          data: {
            connectionId,
            wixContactId: newWixContact.id,
            hubSpotContactId,
            lastSyncedAt: new Date(),
            lastSyncDirection: 'hubspot_to_wix',
            syncSource: 'hubspot',
            correlationId: syncCorrelationId,
            hubSpotVersion: parseInt(hubSpotContactData.properties.hs_updatedate) || 0
          }
        });
      }

      // Update sync record if exists
      if (syncRecord) {
        await prisma.contactSync.update({
          where: { id: syncRecord.id },
          data: {
            lastSyncedAt: new Date(),
            lastSyncDirection: 'hubspot_to_wix',
            syncSource: 'hubspot',
            correlationId: syncCorrelationId,
            hubSpotVersion: parseInt(hubSpotContactData.properties.hs_updatedate) || 0,
            updatedAt: new Date()
          }
        });
      }

      // Log success
      await prisma.syncLog.create({
        data: {
          connectionId,
          syncType: syncRecord ? 'contact_update' : 'contact_create',
          direction: 'hubspot_to_wix',
          status: 'success',
          wixContactId: syncRecord?.wixContactId,
          hubSpotContactId,
          correlationId: syncCorrelationId
        }
      });

    } catch (error) {
      // Log error
      await prisma.syncLog.create({
        data: {
          connectionId,
          syncType: 'contact_update',
          direction: 'hubspot_to_wix',
          status: 'failed',
          hubSpotContactId,
          correlationId: syncCorrelationId,
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        }
      });
      throw error;
    }
  }
}