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
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArnYfRtJDUP1yqnQhnvq0
CGKDdDuJPWx9jHl/PSTwb0yN8nyv9IW19DijXgWAcR0S5kHs41bFtPQAsM+BYTTE
AMaIdA3x0Onf2kUQlLQvl3W45mk8bff0OGHMcVkWdwUVe2PFwZs6bsRBzj/x8TJ/
u7w+2tOB5VNSaTv5J8tDJlferrs6pySR8pwIZ1i72FU3qYg6mE9DVXcSPH0wRqET
3MzWqWugcCiVW9dCqHb6Uv0wi1zc3twXZIuXj/JqUxN2X+jSvomBKZZ2C+iw7S9b
HpCfgnJvMdHxayDR1gxw6HOXUNWXhnqCIHg7tV2wY5AvqH9170QBpPqRml8RxjOz
CQIDAQAB
-----END PUBLIC KEY-----`;

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
    
    // Respond 200 IMMEDIATELY as Wix requires response within 1250ms
    res.status(200).send();

    try {
      // Verify and decode the JWT payload
      const decodedPayload = jwt.verify(req.body, PUBLIC_KEY) as any;
      const event = JSON.parse(decodedPayload.data);
      const eventData = JSON.parse(event.data);
      
      logger.info('✅ Successfully decoded JWT webhook payload');
      logger.info('📋 Event type:', { eventType: event.eventType });
      logger.info('📋 Instance ID:', { instanceId: event.instanceId });
      
      // Handle different event types
      switch (event.eventType) {
        case "com.wixpress.formbuilder.api.v1.FormSubmittedEvent":
          logger.info('📋 Processing form submission event');
          await this.processFormSubmissionEvent(event, eventData);
          break;
          
        case "com.wixpress.crm.v1.ContactCreatedEvent":
          logger.info('👤 Processing contact created event via JWT');
          await this.processContactEventFromJWT(event, eventData, 'created');
          break;
          
        case "com.wixpress.crm.v1.ContactUpdatedEvent":
          logger.info('👤 Processing contact updated event via JWT');
          await this.processContactEventFromJWT(event, eventData, 'updated');
          break;
          
        default:
          logger.info(`Received unknown event type: ${event.eventType}`);
          break;
      }
      
    } catch (err) {
      // If JWT verification fails, try processing with Wix SDK (for contact events)
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
  // Based on Wix docs: fieldName and fieldValue structure
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

      // Extract contact information from form submission
      // According to Wix docs: submissionData array with fieldName and fieldValue
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

      // Also check direct fields as fallback
      if (!email && formData.email) {
        contactInfo.email = formData.email;
        email = formData.email;
      }

      if (!email) {
        logger.error('❌ No email found in form submission');
        return;
      }

      // Try to get UTM parameters from the form data or use defaults
      // Wix may send UTM data in the submissionData or as separate fields
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

      // Map UTM to HubSpot properties
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

      // Check if contact already exists in our sync records using the Wix contactId
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
        // Update existing contact in HubSpot
        await this.hubspotService.updateContact(
          connection.id,
          existingSync.hubSpotContactId,
          contactInfo
        );
        result = { id: existingSync.hubSpotContactId, isNew: false };
        logger.info('🔄 Updated existing HubSpot contact from form submission');
      } else {
        // Create or update contact by email
        result = await this.hubspotService.createOrUpdateContact(
          connection.id,
          email,
          contactInfo
        );
        
        // If we have a Wix contact ID, create the mapping
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

      // Store form submission record with full data
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
  // PROCESS CONTACT EVENT FROM JWT WEBHOOK
  // ─────────────────────────────────────────────
  private async processContactEventFromJWT(event: any, eventData: any, eventType: 'created' | 'updated') {
    const correlationId = uuidv4();
    
    try {
      const instanceId = event.instanceId;
      const contact = eventData.contact || eventData;
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

      // Loop prevention
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

      // Extract email
      const primaryEmail = contact.primaryEmail?.email || 
                          contact.emails?.find((e: any) => e.primary)?.email ||
                          contact.email;

      if (!primaryEmail) {
        logger.warn('⚠️ No email on contact — skipping sync', { contactId });
        return;
      }

      // Build WixContact object
      const wixContactData: WixContact = {
        id: contactId,
        email: primaryEmail,
        firstName: contact.name?.first || contact.firstName,
        lastName: contact.name?.last || contact.lastName,
        phone: contact.phoneNumber || contact.phone,
        version: contact.version || contact.revision || 0,
      };

      const hubSpotData = await this.mappingService.transformWixToHubSpot(
        connection.id,
        wixContactData
      );

      if (!hubSpotData.email) {
        logger.error('❌ No email after transformation');
        return;
      }

      const result = await this.hubspotService.createOrUpdateContact(
        connection.id,
        hubSpotData.email,
        hubSpotData
      );

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
      });

    } catch (error) {
      logger.error(`❌ Error processing contact ${eventType} from JWT`, error);
    }
  }

  // ─────────────────────────────────────────────
  // PROCESS WIX CONTACT EVENT (from SDK)
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

      // Loop prevention
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
        const primaryEmail =
          contact?.primaryInfo?.email ||
          contact?.info?.emails?.items?.[0]?.email ||
          contact?.primaryEmail?.email ||
          null;

        if (!primaryEmail) {
          logger.warn('⚠️ No email on contact — skipping sync', { contactId });
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

        const result = await this.hubspotService.createOrUpdateContact(
          connection.id,
          hubSpotData.email,
          hubSpotData
        );

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
  // HUBSPOT → WIX WEBHOOK
  // ─────────────────────────────────────────────
  handleHubSpotWebhook = async (req: Request, res: Response) => {
    logger.info('🔄 HubSpot webhook received (HubSpot → Wix)');

    try {
      const events = Array.isArray(req.body) ? req.body : [req.body];

      for (const event of events) {
        const { portalId, subscriptionType, objectId } = event;

        const connection = await prisma.hubSpotConnection.findFirst({
          where: { hubSpotPortalId: portalId?.toString(), isConnected: true },
        });

        if (!connection) {
          logger.warn('No connection found for HubSpot portal', { portalId });
          continue;
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