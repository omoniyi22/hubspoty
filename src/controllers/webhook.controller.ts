// src/controllers/webhook.controller.ts
import { Request, Response } from 'express';
import { AppStrategy, createClient } from "@wix/sdk";
import { contacts } from "@wix/crm";
import { prisma } from '../config/database';
import { HubSpotService } from '../services/hubspot.service';
import { SyncService } from '../services/sync.service';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const PUBLIC_KEY =`-----BEGIN PUBLIC KEY-----
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
// Created ONCE at module level. Event handlers
// registered in constructor — exactly as Wix docs.
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

  constructor() {
    this.registerWixEventHandlers();
  }

  // ─────────────────────────────────────────────
  // REGISTER WIX SDK EVENT HANDLERS
  // These fire AFTER wixClient.webhooks.process()
  // decodes and verifies the JWT payload.
  // ─────────────────────────────────────────────
  private registerWixEventHandlers() {

    // ── CONTACT CREATED ──────────────────────
    wixClient.contacts.onContactCreated(async (event) => {
      logger.info('🟢 [WIX SDK] onContactCreated fired');
      logger.info('📦 Full raw event:', { event: JSON.stringify(event, null, 2) });
      logger.info('🔑 instanceId:', { instanceId: event.metadata?.instanceId });
      logger.info('📋 Contact data:', { contact: JSON.stringify(event.data?.contact, null, 2) });

      await this.processWixContactEvent(event, 'created');
    });

    // ── CONTACT UPDATED ──────────────────────
    wixClient.contacts.onContactUpdated(async (event) => {
      logger.info('🔵 [WIX SDK] onContactUpdated fired');
      logger.info('📦 Full raw event:', { event: JSON.stringify(event, null, 2) });
      logger.info('🔑 instanceId:', { instanceId: event.metadata?.instanceId });
      logger.info('📋 Contact data:', { contact: JSON.stringify(event.data?.contact, null, 2) });

      await this.processWixContactEvent(event, 'updated');
    });

    logger.info('✅ Wix SDK event handlers registered (onContactCreated, onContactUpdated)');
  }

  // ─────────────────────────────────────────────
  // CORE WIX WEBHOOK ENDPOINT
  //
  // CRITICAL REQUIREMENTS (from Wix docs):
  //  1. Route MUST use express.text() middleware
  //     NOT express.json() — Wix sends raw JWT text
  //  2. Must call wixClient.webhooks.process(req.body)
  //  3. Must return 200 within 1250ms
  //
  // In your routes file use:
  //   router.post('/wix', express.text(), webhookController.handleWixWebhook)
  // ─────────────────────────────────────────────
  handleWixWebhook = async (req: Request, res: Response) => {
    logger.info('📩 Wix webhook HTTP POST received');
    logger.info('📋 Content-Type header:', { contentType: req.headers['content-type'] });
    logger.info('📋 Raw body type:', { type: typeof req.body });
    logger.info('📋 Raw body (first 500 chars):', { body: String(req.body).substring(0, 500) });

    // ── IMPORTANT: Respond 200 IMMEDIATELY ──
    // Wix requires a 200 within 1250ms.
    // The SDK event handlers fire asynchronously after this.
    res.status(200).send();

    // ── Process the JWT payload via Wix SDK ──
    try {
      logger.info('🔄 Calling wixClient.webhooks.process()...');
      await wixClient.webhooks.process(req.body);
      logger.info('✅ wixClient.webhooks.process() completed — SDK event handlers fired above');
    } catch (err) {
      // 200 already sent — just log the error
      logger.error('❌ wixClient.webhooks.process() error:', err);
      logger.error('❌ Body that failed (full):', { body: String(req.body) });
    }
  };

  // ─────────────────────────────────────────────
  // PROCESS WIX CONTACT EVENT → HUBSPOT
  // Shared handler for both created + updated
  // ─────────────────────────────────────────────
  private async processWixContactEvent(event: any, eventType: 'created' | 'updated') {
    const correlationId = uuidv4();
    const startTime = Date.now();

    try {
      const instanceId = event.metadata?.instanceId;
      const contact = event.data?.contact;

      logger.info(`🔄 Processing contact ${eventType}`, {
        correlationId,
        instanceId,
        contactId: contact?.id,
      });

      // ── Guards ──
      if (!instanceId) {
        logger.error('❌ Missing instanceId in event metadata', { metadata: event.metadata });
        return;
      }

      if (!contact || !contact.id) {
        logger.error('❌ Missing contact or contact.id', { eventData: event.data });
        return;
      }

      // ── Find HubSpot connection for this Wix site ──
      const connection = await prisma.hubSpotConnection.findFirst({
        where: { wixInstanceId: instanceId, isConnected: true },
      });

      if (!connection) {
        logger.warn('⚠️ No active HubSpot connection for instanceId', { instanceId });
        return;
      }

      // ── Loop prevention ──
      // Skip if this contact was recently synced FROM HubSpot (prevents ping-pong)
      const recentHubSpotSync = await prisma.contactSync.findFirst({
        where: {
          connectionId: connection.id,
          wixContactId: contact.id,
          lastSyncDirection: 'hubspot_to_wix',
          lastSyncedAt: { gte: new Date(Date.now() - 60_000) },
        },
      });

      if (recentHubSpotSync) {
        logger.info('🛡️ Loop prevention: skipping — recently synced from HubSpot', {
          contactId: contact.id,
          correlationId: recentHubSpotSync.correlationId,
        });
        return;
      }

      // ── Extract email — try all known Wix contact structures ──
      const primaryEmail =
        contact.primaryInfo?.email ||
        contact.info?.emails?.items?.[0]?.email ||
        contact.emails?.[0]?.email ||
        contact.email ||
        null;

      logger.info('📧 Extracted email:', { primaryEmail });

      if (!primaryEmail) {
        logger.warn('⚠️ No email on contact — skipping HubSpot sync', { contactId: contact.id });
        return;
      }

      // ── Extract other fields ──
      const firstName =
        contact.info?.name?.first ||
        contact.name?.first ||
        contact.firstName ||
        null;

      const lastName =
        contact.info?.name?.last ||
        contact.name?.last ||
        contact.lastName ||
        null;

      const phone =
        contact.primaryInfo?.phone ||
        contact.info?.phones?.items?.[0]?.phone ||
        contact.phones?.[0]?.phone ||
        contact.phone ||
        null;

      // ── Build HubSpot payload ──
      const hubSpotData: Record<string, any> = { email: primaryEmail };
      if (firstName) hubSpotData.firstname = firstName;
      if (lastName) hubSpotData.lastname = lastName;
      if (phone) hubSpotData.phone = phone;

      logger.info('📤 Syncing to HubSpot:', { hubSpotData, correlationId });

      // ── Sync to HubSpot ──
      const result = await this.hubspotService.createOrUpdateContact(
        connection.id,
        primaryEmail,
        hubSpotData
      );

      logger.info('✅ HubSpot sync result:', {
        hubSpotContactId: result.id,
        isNew: result.isNew,
      });

      // ── Persist sync record ──
      await prisma.contactSync.upsert({
        where: {
          connectionId_wixContactId: {
            connectionId: connection.id,
            wixContactId: contact.id,
          },
        },
        update: {
          hubSpotContactId: result.id,
          lastSyncedAt: new Date(),
          lastSyncDirection: 'wix_to_hubspot',
          syncSource: 'wix',
          correlationId,
        },
        create: {
          connectionId: connection.id,
          wixContactId: contact.id,
          hubSpotContactId: result.id,
          lastSyncedAt: new Date(),
          lastSyncDirection: 'wix_to_hubspot',
          syncSource: 'wix',
          correlationId,
        },
      });

      logger.info(`✅ Contact ${eventType} sync complete`, {
        wixContactId: contact.id,
        hubSpotContactId: result.id,
        email: primaryEmail,
        isNew: result.isNew,
        durationMs: Date.now() - startTime,
        correlationId,
      });

    } catch (error) {
      logger.error(`❌ Error processing Wix contact ${eventType}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
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
    logger.info('📦 HubSpot payload:', { body: JSON.stringify(req.body, null, 2) });

    try {
      const events = Array.isArray(req.body) ? req.body : [req.body];

      for (const event of events) {
        const { portalId, eventType, objectId } = event;
        logger.info('Processing HubSpot event', { portalId, eventType, objectId });

        const connection = await prisma.hubSpotConnection.findFirst({
          where: { hubSpotPortalId: portalId?.toString(), isConnected: true },
        });

        if (!connection) {
          logger.warn('No connection found for HubSpot portal', { portalId });
          continue;
        }

        // ── Loop prevention: skip if recently synced from Wix ──
        const recentWixSync = await prisma.syncLog.findFirst({
          where: {
            connectionId: connection.id,
            hubSpotContactId: objectId?.toString(),
            direction: 'wix_to_hubspot',
            createdAt: { gte: new Date(Date.now() - 60_000) },
          },
        });

        if (recentWixSync) {
          logger.info('🛡️ Loop prevention: skipping HubSpot event — recently synced from Wix', { objectId });
          continue;
        }

        if (eventType === 'contact.creation' || eventType === 'contact.propertyChange') {
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

          logger.info('✅ HubSpot event synced to Wix', { objectId, eventType });
        }
      }

      res.status(200).send('OK');
    } catch (error) {
      logger.error('❌ Error processing HubSpot webhook', error);
      res.status(500).json({ error: 'Failed to process HubSpot webhook' });
    }
  };

  // ─────────────────────────────────────────────
  // WIX FORM SUBMISSION → HUBSPOT
  // ─────────────────────────────────────────────
  handleWixFormSubmitted = async (req: Request, res: Response) => {
    const startTime = Date.now();
    const correlationId = uuidv4();

    logger.info('📋 Wix form submission received');
    logger.info('📦 Form payload:', { body: JSON.stringify(req.body, null, 2) });

    try {
      const jsonBody = typeof req.body === 'object' ? req.body : JSON.parse(req.body);
      const instanceId = jsonBody.instanceId || jsonBody.instance_id;
      const formData = jsonBody.formData || jsonBody;

      if (!instanceId) {
        return res.status(400).json({ error: 'Missing instanceId' });
      }

      const connection = await prisma.hubSpotConnection.findFirst({
        where: { wixInstanceId: instanceId, isConnected: true },
      });

      if (!connection) {
        return res.status(404).json({ error: 'No HubSpot connection found' });
      }

      const contactInfo: Record<string, any> = {};

      if (formData.email) contactInfo.email = formData.email;
      if (formData.firstName || formData.first_name) contactInfo.firstname = formData.firstName || formData.first_name;
      if (formData.lastName || formData.last_name) contactInfo.lastname = formData.lastName || formData.last_name;
      if (formData.phone) contactInfo.phone = formData.phone;

      // Handle Wix submissions array format
      if (formData.submissions && Array.isArray(formData.submissions)) {
        for (const sub of formData.submissions) {
          const fieldId = (sub.fieldId || '').toLowerCase();
          const value = sub.value;
          if (fieldId.includes('email')) contactInfo.email = value;
          if (fieldId.includes('first')) contactInfo.firstname = value;
          if (fieldId.includes('last')) contactInfo.lastname = value;
          if (fieldId.includes('phone')) contactInfo.phone = value;
        }
      }

      // UTM attribution
      const utmParams = formData.utmParams || {};
      if (utmParams.utm_source) contactInfo.hs_analytics_source = utmParams.utm_source;

      logger.info('📤 Form contact payload for HubSpot:', { contactInfo, utmParams });

      if (!contactInfo.email) {
        logger.error('❌ No email in form submission');
        return res.status(400).json({ error: 'Email is required' });
      }

      const result = await this.hubspotService.createOrUpdateContact(
        connection.id,
        contactInfo.email,
        contactInfo
      );

      await prisma.formSubmission.create({
        data: {
          connectionId: connection.id,
          wixFormId: formData.formId || 'unknown',
          hubSpotContactId: result.id,
          formData: formData as any,
          utmParams: utmParams,
          syncedToHubSpot: true,
          hubSpotSubmissionId: result.id,
        },
      });

      logger.info('✅ Form submission synced to HubSpot', {
        contactId: result.id,
        isNew: result.isNew,
        durationMs: Date.now() - startTime,
        correlationId,
      });

      res.json({ success: true, contactId: result.id, isNew: result.isNew });

    } catch (error) {
      logger.error('❌ Error processing form submission', error);
      res.status(500).json({ error: 'Failed to process form submission' });
    }
  };
}
