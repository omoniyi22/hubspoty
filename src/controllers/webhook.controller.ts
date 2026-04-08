import { Request, Response } from 'express';
import { AppStrategy, createClient } from "@wix/sdk";
import { contacts } from "@wix/crm";
import { prisma } from '../config/database';
import { HubSpotService } from '../services/hubspot.service';
import { SyncService } from '../services/sync.service';
import { MappingService } from '../services/mapping.service';
import { WixContact } from '../types';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { WixService } from '../services/wix.service';

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const PUBLIC_KEY = process.env.WIX_PUBLIC_KEY?.replace(/\\n/g, '\n').trim() || '';
const APP_ID = process.env.WIX_APP_ID || "c2f37193-e5c1-4088-a013-12362ea400f4";

// ─────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────
const logger = {
  info: (message: string, data?: any) =>
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data, null, 2) : ''),
  error: (message: string, error?: any) =>
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error),
  warn: (message: string, data?: any) =>
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data, null, 2) : ''),
  debug: (message: string, data?: any) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  }
};

// ─────────────────────────────────────────────
// WIX SDK CLIENT
// ─────────────────────────────────────────────
const wixClient = createClient({
  auth: AppStrategy({
    appId: APP_ID,
    publicKey: PUBLIC_KEY,
  }),
  modules: { contacts },
});

export class WebhookController {
  private syncService = SyncService.getInstance();
  private hubspotService = HubSpotService.getInstance();
  private mappingService = MappingService.getInstance();
  private wixService = WixService.getInstance();
  private processingLocks = new Map<string, boolean>();

  // ✅ INFINITE LOOP PREVENTION: Track recently processed events
  private recentProcessedEvents = new Map<string, number>();
  private recentSyncLogs = new Map<string, number>();

  constructor() {
    // ✅ FIX: Use ONLY JWT webhooks, disable SDK handlers to prevent duplicates
    // this.registerWixEventHandlers(); // DISABLED - using JWT only
    logger.info('✅ WebhookController initialized (JWT webhooks only - SDK disabled)');
  }

  // ─────────────────────────────────────────────
  // UNIFIED WIX WEBHOOK HANDLER
  // Handles BOTH contact events AND form submissions
  // ─────────────────────────────────────────────
  handleWixWebhook = async (req: Request, res: Response) => {
    logger.info('📩 Wix webhook HTTP POST received');

    // Always respond immediately to avoid timeout
    res.status(200).send();

    try {
      const decodedPayload = jwt.verify(req.body, PUBLIC_KEY) as any;
      const event = JSON.parse(decodedPayload.data);
      const eventData = JSON.parse(event.data);

      logger.info('✅ Successfully decoded JWT webhook payload');
      logger.info('📋 Event type:', { eventType: event.eventType });
      logger.info('📋 Instance ID:', { instanceId: event.instanceId });

      switch (event.eventType) {
        case "com.wixpress.formbuilder.api.v1.FormSubmittedEvent":
          logger.info('📋 Processing form submission event');
          await this.processFormSubmissionEvent(event, eventData);
          break;

        case "wix.contacts.v4.contact_created":
          logger.info('👤 Processing contact created event via JWT');
          await this.processContactEventFromJWT(event, eventData, 'created');
          break;

        case "wix.contacts.v4.contact_updated":
          logger.info('👤 Processing contact updated event via JWT');
          await this.processContactEventFromJWT(event, eventData, 'updated');
          break;

        default:
          logger.info(`Received unknown event type: ${event.eventType}`);
          break;
      }

    } catch (err) {
      logger.error('❌ Error processing JWT webhook:', err);
      // Don't fall back to SDK - JWT only mode
    }
  };

  // ─────────────────────────────────────────────
  // PROCESS FORM SUBMISSION FROM JWT WEBHOOK
  // ─────────────────────────────────────────────
  private async processFormSubmissionEvent(event: any, eventData: any) {
    const correlationId = uuidv4();
    const startTime = Date.now();

    try {
      const instanceId = event.instanceId;
      const formData = eventData;

      // ✅ INFINITE LOOP PREVENTION: Check for duplicate form submission
      const formEventKey = `form-${instanceId}-${formData.contactId}-${formData.submissionTime}`;
      if (this.recentProcessedEvents.has(formEventKey)) {
        logger.info('🛡️ Duplicate form submission detected, skipping', { formEventKey });
        return;
      }
      this.recentProcessedEvents.set(formEventKey, Date.now());
      setTimeout(() => this.recentProcessedEvents.delete(formEventKey), 10000);

      logger.info('📋 Processing form submission', {
        correlationId,
        instanceId,
        formName: formData.formName,
        contactId: formData.contactId,
        submissionTime: formData.submissionTime,
      });

      const connection = await prisma.hubSpotConnection.findFirst({
        where: { wixInstanceId: instanceId, isConnected: true },
      });

      if (!connection) {
        logger.warn('⚠️ No active HubSpot connection for form submission', { instanceId });
        return;
      }

      const contactInfo: Record<string, any> = {};
      let email = null;
      let firstName = null;
      let lastName = null;
      let phone = null;
      let company = null;

      if (formData.submissionData && Array.isArray(formData.submissionData)) {
        for (const field of formData.submissionData) {
          const fieldName = (field.fieldName || '').toLowerCase();
          const fieldValue = field.fieldValue;

          if (fieldName.includes('email')) {
            contactInfo.email = fieldValue;
            email = fieldValue;
          }
          if (fieldName.includes('first')) {
            contactInfo.firstname = fieldValue;
            firstName = fieldValue;
          }
          if (fieldName.includes('last')) {
            contactInfo.lastname = fieldValue;
            lastName = fieldValue;
          }
          if (fieldName.includes('phone')) {
            contactInfo.phone = fieldValue;
            phone = fieldValue;
          }
          if (fieldName.includes('company')) {
            contactInfo.company = fieldValue;
            company = fieldValue;
          }
        }
      }

      if (!email && formData.email) {
        contactInfo.email = formData.email;
        email = formData.email;
      }

      if (!email) {
        logger.error('❌ No email found in form submission');
        return;
      }

      const utmParams = {
        utm_source: formData.utm_source || formData.utmSource || null,
        utm_medium: formData.utm_medium || formData.utmMedium || null,
        utm_campaign: formData.utm_campaign || formData.utmCampaign || null,
        utm_term: formData.utm_term || formData.utmTerm || null,
        utm_content: formData.utm_content || formData.utmContent || null,
        page_url: formData.pageUrl || formData.url || null,
        referrer: formData.referrer || null,
        timestamp: new Date().toISOString(),
        wix_contact_id: formData.contactId || null,
      };

      if (utmParams.utm_source) contactInfo.hs_analytics_source = utmParams.utm_source;
      if (utmParams.utm_medium) contactInfo.hs_analytics_medium = utmParams.utm_medium;
      if (utmParams.utm_campaign) contactInfo.hs_analytics_campaign = utmParams.utm_campaign;
      if (utmParams.utm_term) contactInfo.hs_analytics_term = utmParams.utm_term;
      if (utmParams.utm_content) contactInfo.hs_analytics_content = utmParams.utm_content;
      if (utmParams.page_url) contactInfo.hs_analytics_original_url = utmParams.page_url;
      if (utmParams.referrer) contactInfo.hs_analytics_referrer = utmParams.referrer;

      let wixContactId = formData.contactId;
      let existingSync: any = null;

      if (wixContactId) {
        existingSync = await prisma.contactSync.findFirst({
          where: {
            connectionId: connection.id,
            wixContactId: wixContactId,
          },
        });
      }


      let result;

      if (existingSync) {
        await this.hubspotService.updateContact(
          connection.id,
          existingSync.hubSpotContactId,
          contactInfo
        );
        result = { id: existingSync.hubSpotContactId, isNew: false };
        logger.info('🔄 Updated existing HubSpot contact from form submission by ID');
      } else {
        // ✅ Use createOrUpdateContact to handle duplicates gracefully
        result = await this.hubspotService.createOrUpdateContact(
          connection.id,
          email,
          contactInfo
        );

        if (wixContactId && result.isNew) {
          await prisma.contactSync.create({
            data: {
              connectionId: connection.id,
              wixContactId: wixContactId,
              hubSpotContactId: result.id,
              lastSyncedAt: new Date(),
              lastSyncDirection: 'wix_to_hubspot',
              syncSource: 'form_submission',
              correlationId: correlationId,
            },
          }).catch((err: any) => {
            if (err.code === 'P2002') {
              logger.info('Sync record already exists, skipping creation');
            } else {
              throw err;
            }
          });
        }
      }

      await prisma.formSubmission.create({
        data: {
          connectionId: connection.id,
          wixFormId: formData.formName || formData.formId || 'unknown',
          hubSpotContactId: result.id,
          formData: {
            formName: formData.formName,
            submissionData: formData.submissionData,
            submissionTime: formData.submissionTime,
            contactId: formData.contactId,
          },
          utmParams: utmParams,
          syncedToHubSpot: true,
          hubSpotSubmissionId: result.id,
        },
      }).catch((err: any) => {
        if (err.code === 'P2002') {
          logger.info('Form submission already exists, skipping');
        } else {
          logger.error('Failed to save form submission:', err);
        }
      });

      logger.info('✅ Form submission processed successfully', {
        contactId: result.id,
        isNew: result.isNew,
        email,
        wixContactId,
        formName: formData.formName,
        durationMs: Date.now() - startTime,
        correlationId,
      });

    } catch (error) {
      logger.error('❌ Error processing form submission event', error);
    }
  }

  // ─────────────────────────────────────────────
  // PROCESS CONTACT EVENT FROM JWT WEBHOOK - WITH INFINITE LOOP PREVENTION
  // ─────────────────────────────────────────────
  private async processContactEventFromJWT(event: any, eventData: any, eventType: 'created' | 'updated') {
    const correlationId = uuidv4();

    try {
      const instanceId = event.instanceId;
      let contact = eventData.contact || eventData;

      // Extract the actual contact data
      if (contact.updatedEvent?.currentEntity) {
        contact = contact.updatedEvent.currentEntity;
      }
      if (contact.createdEvent?.currentEntity) {
        contact = contact.createdEvent.currentEntity;
      }

      const contactId = contact.id || contact._id;

      // ✅ INFINITE LOOP PREVENTION: Check if this exact event was recently processed
      const eventKey = `${instanceId}-${contactId}-${eventType}-${contact.revision || 0}`;
      if (this.recentProcessedEvents.has(eventKey)) {
        logger.info('🛡️ Duplicate contact event detected, skipping', { eventKey, contactId });
        return;
      }
      this.recentProcessedEvents.set(eventKey, Date.now());
      setTimeout(() => this.recentProcessedEvents.delete(eventKey), 10000);

      logger.info(`🔄 Processing contact ${eventType} from JWT`, {
        correlationId,
        instanceId,
        contactId,
        revision: contact.revision,
      });

      const connection = await prisma.hubSpotConnection.findFirst({
        where: { wixInstanceId: instanceId, isConnected: true },
      });

      if (!connection) {
        logger.warn('⚠️ No active HubSpot connection', { instanceId });
        return;
      }

      // ✅ INFINITE LOOP PREVENTION: Check for recent HubSpot → Wix sync (would cause loop)
      const recentHubspotToWixSync = await prisma.contactSync.findFirst({
        where: {
          connectionId: connection.id,
          wixContactId: contactId,
          lastSyncDirection: 'hubspot_to_wix',
          lastSyncedAt: { gte: new Date(Date.now() - 60_000) },
        },
      });

      if (recentHubspotToWixSync) {
        logger.info('🛡️ Loop prevention: skipping — recently synced FROM HubSpot', { contactId });
        return;
      }

      // Extract email from the correct path
      const primaryEmail =
        contact?.primaryInfo?.email ||
        contact?.primaryEmail?.email ||
        contact?.info?.primaryEmail?.email ||
        contact?.info?.emails?.items?.find((e: any) => e.primary)?.email ||
        contact?.info?.emails?.items?.[0]?.email ||
        contact?.email ||
        null;

      if (!primaryEmail) {
        logger.warn('⚠️ No email on contact — skipping sync', { contactId });
        return;
      }

      const firstName = contact?.info?.name?.first || contact?.name?.first || null;
      const lastName = contact?.info?.name?.last || contact?.name?.last || null;
      const phone = contact?.primaryInfo?.phone || contact?.primaryPhone?.phone || null;

      const wixContactData: WixContact = {
        id: contactId,
        email: primaryEmail,
        firstName: firstName,
        lastName: lastName,
        phone: phone,
        version: contact.revision || contact.version || 0,
      };

      const hubSpotData = await this.mappingService.transformWixToHubSpot(
        connection.id,
        wixContactData
      );

      if (!hubSpotData.email) {
        logger.error('❌ No email after transformation');
        return;
      }

      const existingSyncRecord = await prisma.contactSync.findUnique({
        where: {
          connectionId_wixContactId: {
            connectionId: connection.id,
            wixContactId: contactId,
          },
        },
      });

      let result;

      if (existingSyncRecord) {
        logger.info(`🔄 [JWT] Updating existing HubSpot contact by ID: ${existingSyncRecord.hubSpotContactId}`);
        await this.hubspotService.updateContact(
          connection.id,
          existingSyncRecord.hubSpotContactId,
          hubSpotData
        );
        result = { id: existingSyncRecord.hubSpotContactId, isNew: false };
      } else {
        // ✅ Use createOrUpdateContact to handle 409 gracefully
        logger.info(`🆕 [JWT] Creating/updating HubSpot contact for: ${primaryEmail}`);
        result = await this.hubspotService.createOrUpdateContact(
          connection.id,
          primaryEmail,
          hubSpotData
        );
      }

      // ✅ Use upsert to avoid P2002 unique constraint errors
      await prisma.contactSync.upsert({
        where: {
          connectionId_wixContactId: {
            connectionId: connection.id,
            wixContactId: contactId,
          },
        },
        update: {
          hubSpotContactId: result.id,
          lastSyncedAt: new Date(),
          lastSyncDirection: 'wix_to_hubspot',
          syncSource: 'wix_jwt',
          correlationId: correlationId,
          wixVersion: contact.revision || 0,
          updatedAt: new Date(),
        },
        create: {
          connectionId: connection.id,
          wixContactId: contactId,
          hubSpotContactId: result.id,
          lastSyncedAt: new Date(),
          lastSyncDirection: 'wix_to_hubspot',
          syncSource: 'wix_jwt',
          correlationId: correlationId,
          wixVersion: contact.revision || 0,
        },
      }).catch((err: any) => {
        if (err.code === 'P2002') {
          logger.info('Sync record already exists, skipping upsert', { contactId, hubSpotId: result.id });
        } else {
          throw err;
        }
      });

      // ✅ Create sync log but handle duplicates gracefully
      await prisma.syncLog.create({
        data: {
          connectionId: connection.id,
          syncType: result.isNew ? 'contact_create' : 'contact_update',
          direction: 'wix_to_hubspot',
          status: 'success',
          wixContactId: contactId,
          hubSpotContactId: result.id,
          correlationId: correlationId,
          requestData: hubSpotData,
          responseData: { id: result.id, isNew: result.isNew },
        },
      }).catch((err: any) => {
        if (err.code !== 'P2002') {
          logger.error('Failed to create sync log:', err);
        }
      });

      logger.info(`✅ Contact ${eventType} synced from JWT`, {
        wixContactId: contactId,
        hubSpotContactId: result.id,
        wasUpdate: !!existingSyncRecord,
        isNew: result.isNew,
      });

    } catch (error) {
      logger.error(`❌ Error processing contact ${eventType} from JWT`, error);

      // Log failure but don't throw - prevent crash
      await prisma.syncLog.create({
        data: {
          connectionId: 'unknown',
          syncType: 'contact_update',
          direction: 'wix_to_hubspot',
          status: 'failed',
          wixContactId: null,
          hubSpotContactId: null,
          correlationId: correlationId,
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      }).catch(() => { });
    }
  }

  // ─────────────────────────────────────────────
  // HUBSPOT → WIX WEBHOOK - WITH INFINITE LOOP PREVENTION
  // ─────────────────────────────────────────────
  handleHubSpotWebhook = async (req: Request, res: Response) => {
    logger.info('🔄 HubSpot webhook received (HubSpot → Wix)');

    try {
      const events = Array.isArray(req.body) ? req.body : [req.body];
      const processedEventKeys = new Set<string>();

      for (const event of events) {
        const { portalId, subscriptionType, objectId, propertyName, propertyValue } = event;

        // Skip events without propertyName
        if (!propertyName) {
          logger.info('🛡️ Skipping event - no propertyName', { subscriptionType, objectId });
          continue;
        }

        const eventKey = `${portalId}-${objectId}-${subscriptionType}-${propertyName}`;

        if (processedEventKeys.has(eventKey)) {
          logger.info('🛡️ Duplicate event detected in batch, skipping');
          continue;
        }
        processedEventKeys.add(eventKey);

        if (this.recentProcessedEvents.has(eventKey)) {
          logger.info('🛡️ Recent duplicate event detected, skipping', { eventKey });
          continue;
        }
        this.recentProcessedEvents.set(eventKey, Date.now());
        setTimeout(() => this.recentProcessedEvents.delete(eventKey), 10000);

        const connection = await prisma.hubSpotConnection.findFirst({
          where: { hubSpotPortalId: portalId?.toString(), isConnected: true },
        });

        if (!connection) {
          logger.warn('No connection found for HubSpot portal', { portalId });
          continue;
        }

        // Loop prevention
        const recentWixToHubspotSync = await prisma.syncLog.findFirst({
          where: {
            connectionId: connection.id,
            hubSpotContactId: objectId?.toString(),
            direction: 'wix_to_hubspot',
            status: 'success',
            createdAt: { gte: new Date(Date.now() - 60_000) },
          },
        });

        if (recentWixToHubspotSync) {
          logger.info('🛡️ Loop prevention: skipping HubSpot event — recently synced from Wix', {
            objectId,
            secondsAgo: (Date.now() - recentWixToHubspotSync.createdAt.getTime()) / 1000
          });
          continue;
        }

        const syncRecord = await prisma.contactSync.findUnique({
          where: {
            connectionId_hubSpotContactId: {
              connectionId: connection.id,
              hubSpotContactId: objectId?.toString()
            }
          }
        });

        if (!syncRecord) {
          logger.warn('No sync record found for HubSpot contact', { objectId });
          continue;
        }

        // ============================================================
        // CAUTIOUS APPROACH: Try database mapping first, fallback to hardcoded
        // ============================================================

        let wixField: string | null = null;
        let shouldSync = true;
        let direction = 'unknown';

        try {
          // Try to get mapping from database
          const fieldMapping = await this.mappingService.getFieldMapping(connection.id);
          const mapping = fieldMapping.mappings.find(m => m.hubSpotProperty === propertyName);

          if (mapping) {
            // Database mapping exists
            direction = mapping.direction;

            // Check direction - ONLY skip if explicitly 'wix_to_hubspot'
            if (mapping.direction === 'wix_to_hubspot') {
              shouldSync = false;
              logger.info(`🛡️ Skipping ${propertyName} - direction is 'wix_to_hubspot' (only Wix→HubSpot)`, {
                objectId,
                propertyName
              });
            } else if (mapping.isActive === false) {
              shouldSync = false;
              logger.info(`🛡️ Skipping ${propertyName} - mapping is inactive`, { objectId });
            } else {
              wixField = mapping.wixField;
              logger.info(`📋 Using database mapping for ${propertyName} → ${wixField} (direction: ${direction})`);
            }
          }
        } catch (dbError) {
          logger.warn(`Could not read database mapping for ${propertyName}, using fallback`, dbError);
        }

        // FALLBACK: Use hardcoded mapping if database didn't provide one
        if (!wixField && shouldSync) {
          const hardcodedMap: Record<string, string> = {
            'firstname': 'firstName',
            'lastname': 'lastName',
            'phone': 'phone',
            'email': 'email'
          };

          if (hardcodedMap[propertyName]) {
            wixField = hardcodedMap[propertyName];
            direction = 'bidirectional (fallback)';
            logger.info(`📋 Using fallback mapping for ${propertyName} → ${wixField}`);
          } else {
            // Unknown field - skip
            logger.info(`🛡️ Unknown property ${propertyName}, no mapping found, skipping`);
            shouldSync = false;
          }
        }

        // Perform the update if conditions are met
        if (shouldSync && wixField && propertyValue !== null && propertyValue !== undefined) {
          let updateValue = propertyValue;

          // Basic trim for string values
          if (typeof updateValue === 'string') {
            updateValue = updateValue.trim();
          }

          const updateData: Record<string, any> = { [wixField]: updateValue };

          logger.info(`🔄 Updating Wix contact ${syncRecord.wixContactId}: ${wixField} = ${updateValue} (${direction})`);

          try {
            await this.wixService.updateContact(connection.id, syncRecord.wixContactId, updateData);

            await prisma.contactSync.update({
              where: { id: syncRecord.id },
              data: { lastSyncedAt: new Date() }
            });

            // ✅ ADDED: Create sync log for HubSpot → Wix direction
            await prisma.syncLog.create({
              data: {
                connectionId: connection.id,
                syncType: 'contact_update',
                direction: 'hubspot_to_wix',
                status: 'success',
                wixContactId: syncRecord.wixContactId,
                hubSpotContactId: objectId?.toString(),
                correlationId: uuidv4(),
                requestData: { [propertyName]: propertyValue },
                responseData: { updated: true, field: wixField, value: updateValue },
              },
            }).catch((err: any) => {
              if (err.code !== 'P2002') {
                logger.error('Failed to create sync log:', err);
              }
            });

            logger.info('✅ HubSpot event synced to Wix', {
              objectId,
              subscriptionType,
              propertyName,
              wixField,
              direction
            });
          } catch (updateError) {
            logger.error(`❌ Failed to update Wix contact: ${updateError}`);

            // ✅ ADDED: Log failure
            await prisma.syncLog.create({
              data: {
                connectionId: connection.id,
                syncType: 'contact_update',
                direction: 'hubspot_to_wix',
                status: 'failed',
                wixContactId: syncRecord.wixContactId,
                hubSpotContactId: objectId?.toString(),
                correlationId: uuidv4(),
                requestData: { [propertyName]: propertyValue },
                errorMessage: updateError instanceof Error ? updateError.message : 'Unknown error',
              },
            }).catch(() => { });
          }
        } else {
          logger.debug(`Skipping update for ${propertyName} - shouldSync: ${shouldSync}, wixField: ${wixField}`);
        }
      }

      res.status(200).send('OK');
    } catch (error) {
      logger.error('❌ Error processing HubSpot webhook', error);
      res.status(500).json({ error: 'Failed to process HubSpot webhook' });
    }
  };
}