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

  private processingLocks = new Map<string, boolean>();

  constructor() {
    this.registerWixEventHandlers();
  }

  private registerWixEventHandlers() {
    wixClient.contacts.onContactCreated(async (event) => {
      logger.info('🟢 [WIX SDK] onContactCreated fired');
      await this.processWixContactEvent(event, 'created');
    });

    wixClient.contacts.onContactUpdated(async (event) => {
      logger.info('🔵 [WIX SDK] onContactUpdated fired');
      await this.processWixContactEvent(event, 'updated');
    });

    logger.info('✅ Wix SDK event handlers registered');
  }

  // ─────────────────────────────────────────────
  // UNIFIED WIX WEBHOOK HANDLER
  // Handles BOTH contact events AND form submissions
  // ─────────────────────────────────────────────
  handleWixWebhook = async (req: Request, res: Response) => {
    logger.info('📩 Wix webhook HTTP POST received');

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
      logger.info('Not a JWT payload or JWT verification failed, trying Wix SDK processing...');
      try {
        await wixClient.webhooks.process(req.body);
        logger.info('✅ wixClient.webhooks.process() completed');
      } catch (sdkError) {
        logger.error('❌ Error processing webhook:', sdkError);
      }
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

      logger.info('📊 Form field data extracted:', {
        email,
        firstName,
        lastName,
        phone,
        company,
      });

      logger.info('📊 UTM Attribution captured:', utmParams);

      let wixContactId = formData.contactId;
      let existingSync = null;

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
        result = await this.hubspotService.createContact(
          connection.id,
          { ...contactInfo, email }
        );

        if (wixContactId) {
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
  // PROCESS CONTACT EVENT FROM JWT WEBHOOK - FIXED
  // Source of truth: sync record by Wix ID, NOT email
  // ─────────────────────────────────────────────
  private async processContactEventFromJWT(event: any, eventData: any, eventType: 'created' | 'updated') {
    const correlationId = uuidv4();

    try {
      const instanceId = event.instanceId;
      // IMPORTANT: The contact data is inside updatedEvent.currentEntity for update events
      let contact = eventData.contact || eventData;
      
      // For update events, the actual contact data is in updatedEvent.currentEntity
      if (contact.updatedEvent?.currentEntity) {
        contact = contact.updatedEvent.currentEntity;
      }
      if (contact.createdEvent?.currentEntity) {
        contact = contact.createdEvent.currentEntity;
      }
      
      const contactId = contact.id || contact._id;

      logger.info(`🔄 Processing contact ${eventType} from JWT`, {
        correlationId,
        instanceId,
        contactId,
      });

      const connection = await prisma.hubSpotConnection.findFirst({
        where: { wixInstanceId: instanceId, isConnected: true },
      });

      if (!connection) {
        logger.warn('⚠️ No active HubSpot connection', { instanceId });
        return;
      }

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

      // FIXED: Extract email from the correct path based on the actual data structure
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
        logger.info(`🆕 [JWT] Creating new HubSpot contact for: ${primaryEmail}`);
        const newContact = await this.hubspotService.createContact(
          connection.id,
          { ...hubSpotData, email: hubSpotData.email }
        );
        result = { id: newContact.id, isNew: true };
      }

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
        },
      });

      logger.info(`✅ Contact ${eventType} synced from JWT`, {
        wixContactId: contactId,
        hubSpotContactId: result.id,
        wasUpdate: !!existingSyncRecord,
      });

    } catch (error) {
      logger.error(`❌ Error processing contact ${eventType} from JWT`, error);
    }
  }

  // ─────────────────────────────────────────────
  // PROCESS WIX CONTACT EVENT (from SDK) - FIXED
  // Source of truth: sync record by Wix ID, NOT email
  // ─────────────────────────────────────────────
  private async processWixContactEvent(
    rawEvent: any,
    eventType: 'created' | 'updated'
  ) {
    const correlationId = uuidv4();
    const startTime = Date.now();

    try {
      let parsedEvent: any;

      try {
        parsedEvent =
          typeof rawEvent.event === 'string'
            ? JSON.parse(rawEvent.event)
            : rawEvent;
      } catch (parseError) {
        logger.error('❌ Failed to parse Wix event JSON', { parseError });
        return;
      }

      const instanceId = parsedEvent?.metadata?.instanceId;
      const contactId = parsedEvent?.entity?._id || parsedEvent?.metadata?.entityId || null;
      const contact = parsedEvent?.entity;

      logger.info(`🔄 Processing contact ${eventType} from SDK`, {
        correlationId,
        instanceId,
        contactId,
      });

      if (!instanceId || !contactId) {
        logger.error('❌ Missing instanceId or contactId');
        return;
      }

      const connection = await prisma.hubSpotConnection.findFirst({
        where: {
          wixInstanceId: instanceId,
          isConnected: true,
        },
      });

      if (!connection) {
        logger.warn('⚠️ No active HubSpot connection', { instanceId });
        return;
      }

      const recentHubspotToWixSync = await prisma.contactSync.findFirst({
        where: {
          connectionId: connection.id,
          wixContactId: contactId,
          lastSyncDirection: 'hubspot_to_wix',
          lastSyncedAt: {
            gte: new Date(Date.now() - 60_000),
          },
        },
      });

      if (recentHubspotToWixSync) {
        logger.info('🛡️ Loop prevention: skipping — recently synced FROM HubSpot', { contactId });
        return;
      }

      const duplicateProcessing = await prisma.syncLog.findFirst({
        where: {
          connectionId: connection.id,
          wixContactId: contactId,
          direction: 'wix_to_hubspot',
          status: 'success',
          createdAt: {
            gte: new Date(Date.now() - 10_000),
          },
        },
      });

      if (duplicateProcessing) {
        logger.info('🛡️ Loop prevention: duplicate webhook processing detected', { contactId });
        return;
      }

      const contactVersion = contact?.revision || contact?.version || 0;
      const existingSync = await prisma.contactSync.findUnique({
        where: {
          connectionId_wixContactId: {
            connectionId: connection.id,
            wixContactId: contactId,
          },
        },
      });

      if (existingSync && existingSync.wixVersion >= contactVersion) {
        logger.info('🛡️ Loop prevention: already synced this or newer version', {
          contactId,
          currentVersion: contactVersion,
          syncedVersion: existingSync.wixVersion,
        });
        return;
      }

      const lockKey = `wix-${connection.id}-${contactId}`;
      if (this.processingLocks.get(lockKey)) {
        logger.info('🛡️ Loop prevention: already processing this contact', { contactId });
        return;
      }
      this.processingLocks.set(lockKey, true);

      try {
        // FIXED: Extract email from the correct path
        const primaryEmail =
          contact?.primaryInfo?.email ||
          contact?.primaryEmail?.email ||
          contact?.info?.primaryEmail?.email ||
          contact?.info?.emails?.items?.find((e: any) => e.primary)?.email ||
          contact?.info?.emails?.items?.[0]?.email ||
          null;

        if (!primaryEmail) {
          logger.debug('ℹ️ Skipping contact sync - no email address', { contactId });
          return;
        }

        const firstName = contact?.info?.name?.first || null;
        const lastName = contact?.info?.name?.last || null;
        const phone = contact?.primaryInfo?.phone || contact?.info?.phones?.items?.[0]?.phone || null;

        const wixContactData: WixContact = {
          id: contactId,
          email: primaryEmail,
          firstName: firstName,
          lastName: lastName,
          phone: phone,
          version: contactVersion,
        };

        if (contact?.info?.company && typeof contact.info.company === 'string') {
          wixContactData.company = contact.info.company;
        }
        if (contact?.info?.jobTitle && typeof contact.info.jobTitle === 'string') {
          wixContactData.jobTitle = contact.info.jobTitle;
        }

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
          logger.info(`🔄 [SDK] Updating existing HubSpot contact by ID: ${existingSyncRecord.hubSpotContactId}`);
          await this.hubspotService.updateContact(
            connection.id,
            existingSyncRecord.hubSpotContactId,
            hubSpotData
          );
          result = { id: existingSyncRecord.hubSpotContactId, isNew: false };
        } else {
          logger.info(`🆕 [SDK] Creating new HubSpot contact for: ${primaryEmail}`);
          const newContact = await this.hubspotService.createContact(
            connection.id,
            { ...hubSpotData, email: hubSpotData.email }
          );
          result = { id: newContact.id, isNew: true };
        }

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
            syncSource: 'wix_sdk',
            correlationId: correlationId,
            wixVersion: contactVersion,
            updatedAt: new Date(),
          },
          create: {
            connectionId: connection.id,
            wixContactId: contactId,
            hubSpotContactId: result.id,
            lastSyncedAt: new Date(),
            lastSyncDirection: 'wix_to_hubspot',
            syncSource: 'wix_sdk',
            correlationId: correlationId,
            wixVersion: contactVersion,
          },
        });

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
        });

        logger.info(`✅ Contact ${eventType} sync complete`, {
          wixContactId: contactId,
          hubSpotContactId: result.id,
          email: primaryEmail,
          fieldsSynced: Object.keys(hubSpotData),
          durationMs: Date.now() - startTime,
          correlationId,
          wasUpdate: !!existingSyncRecord,
        });

      } finally {
        setTimeout(() => this.processingLocks.delete(lockKey), 5000);
      }

    } catch (error) {
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

      logger.error(`❌ Error processing Wix contact ${eventType}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
        correlationId,
      });
    }
  }

  // ─────────────────────────────────────────────
  // HUBSPOT → WIX WEBHOOK - WITH DUPLICATE PREVENTION
  // ─────────────────────────────────────────────
  handleHubSpotWebhook = async (req: Request, res: Response) => {
    logger.info('🔄 HubSpot webhook received (HubSpot → Wix)');

    try {
      const events = Array.isArray(req.body) ? req.body : [req.body];
      const processedEventKeys = new Set<string>();

      for (const event of events) {
        const { portalId, subscriptionType, objectId } = event;

        const eventKey = `${portalId}-${objectId}-${subscriptionType}`;

        if (processedEventKeys.has(eventKey)) {
          logger.info('🛡️ Duplicate event detected in batch, skipping', {
            eventKey,
            subscriptionType,
            objectId
          });
          continue;
        }
        processedEventKeys.add(eventKey);

        const connection = await prisma.hubSpotConnection.findFirst({
          where: { hubSpotPortalId: portalId?.toString(), isConnected: true },
        });

        if (!connection) {
          logger.warn('No connection found for HubSpot portal', { portalId });
          continue;
        }

        const recentProcessing = await prisma.syncLog.findFirst({
          where: {
            connectionId: connection.id,
            hubSpotContactId: objectId?.toString(),
            direction: 'hubspot_to_wix',
            status: 'success',
            createdAt: { gte: new Date(Date.now() - 5000) },
          },
        });

        if (recentProcessing) {
          logger.info('🛡️ Skipping duplicate HubSpot event - recently processed', {
            objectId,
            subscriptionType,
            secondsAgo: (Date.now() - recentProcessing.createdAt.getTime()) / 1000
          });
          continue;
        }

        if (subscriptionType === 'contact.creation') {
          const existingSyncRecord = await prisma.contactSync.findUnique({
            where: {
              connectionId_hubSpotContactId: {
                connectionId: connection.id,
                hubSpotContactId: objectId?.toString()
              }
            }
          });

          if (existingSyncRecord) {
            logger.info('🛡️ Contact already has sync record, skipping creation webhook', {
              objectId,
              wixContactId: existingSyncRecord.wixContactId
            });
            continue;
          }
        }

        const recentWixSync = await prisma.syncLog.findFirst({
          where: {
            connectionId: connection.id,
            hubSpotContactId: objectId?.toString(),
            direction: 'wix_to_hubspot',
            status: 'success',
            createdAt: { gte: new Date(Date.now() - 60_000) },
          },
        });

        if (recentWixSync) {
          logger.info('🛡️ Loop prevention: skipping HubSpot event — recently synced from Wix', {
            objectId,
          });
          continue;
        }

        if (subscriptionType === 'contact.creation' || subscriptionType === 'contact.propertyChange') {
          const hubSpotContact = await this.hubspotService.getContact(
            connection.id,
            objectId?.toString()
          );

          await this.syncService.syncHubSpotContactToWix(
            connection.id,
            objectId?.toString(),
            hubSpotContact,
            uuidv4()
          );

          logger.info('✅ HubSpot event synced to Wix', { objectId, subscriptionType });
        }
      }

      res.status(200).send('OK');
    } catch (error) {
      logger.error('❌ Error processing HubSpot webhook', error);
      res.status(500).json({ error: 'Failed to process HubSpot webhook' });
    }
  };
}