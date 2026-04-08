"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookController = void 0;
const sdk_1 = require("@wix/sdk");
const crm_1 = require("@wix/crm");
const database_1 = require("../config/database");
const hubspot_service_1 = require("../services/hubspot.service");
const sync_service_1 = require("../services/sync.service");
const mapping_service_1 = require("../services/mapping.service");
const uuid_1 = require("uuid");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const wix_service_1 = require("../services/wix.service");
// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const PUBLIC_KEY = process.env.WIX_PUBLIC_KEY?.replace(/\\n/g, '\n').trim() || '';
const APP_ID = process.env.WIX_APP_ID || "c2f37193-e5c1-4088-a013-12362ea400f4";
// ─────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────
const logger = {
    info: (message, data) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data, null, 2) : ''),
    error: (message, error) => console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error),
    warn: (message, data) => console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data, null, 2) : ''),
    debug: (message, data) => {
        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data, null, 2) : '');
        }
    }
};
// ─────────────────────────────────────────────
// WIX SDK CLIENT
// ─────────────────────────────────────────────
const wixClient = (0, sdk_1.createClient)({
    auth: (0, sdk_1.AppStrategy)({
        appId: APP_ID,
        publicKey: PUBLIC_KEY,
    }),
    modules: { contacts: crm_1.contacts },
});
class WebhookController {
    constructor() {
        this.syncService = sync_service_1.SyncService.getInstance();
        this.hubspotService = hubspot_service_1.HubSpotService.getInstance();
        this.mappingService = mapping_service_1.MappingService.getInstance();
        this.wixService = wix_service_1.WixService.getInstance();
        this.processingLocks = new Map();
        // ✅ INFINITE LOOP PREVENTION: Track recently processed events
        this.recentProcessedEvents = new Map();
        this.recentSyncLogs = new Map();
        // ─────────────────────────────────────────────
        // UNIFIED WIX WEBHOOK HANDLER
        // Handles BOTH contact events AND form submissions
        // ─────────────────────────────────────────────
        this.handleWixWebhook = async (req, res) => {
            logger.info('📩 Wix webhook HTTP POST received');
            // Always respond immediately to avoid timeout
            res.status(200).send();
            try {
                const decodedPayload = jsonwebtoken_1.default.verify(req.body, PUBLIC_KEY);
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
            }
            catch (err) {
                logger.error('❌ Error processing JWT webhook:', err);
                // Don't fall back to SDK - JWT only mode
            }
        };
        // ─────────────────────────────────────────────
        // HUBSPOT → WIX WEBHOOK - WITH INFINITE LOOP PREVENTION
        // ─────────────────────────────────────────────
        this.handleHubSpotWebhook = async (req, res) => {
            logger.info('🔄 HubSpot webhook received (HubSpot → Wix)');
            try {
                const events = Array.isArray(req.body) ? req.body : [req.body];
                const processedEventKeys = new Set();
                for (const event of events) {
                    const { portalId, subscriptionType, objectId, propertyName, propertyValue } = event;
                    const eventKey = `${portalId}-${objectId}-${subscriptionType}-${propertyName}`;
                    if (processedEventKeys.has(eventKey)) {
                        logger.info('🛡️ Duplicate event detected in batch, skipping');
                        continue;
                    }
                    processedEventKeys.add(eventKey);
                    // ✅ INFINITE LOOP PREVENTION: Check if this event was just processed
                    if (this.recentProcessedEvents.has(eventKey)) {
                        logger.info('🛡️ Recent duplicate event detected, skipping', { eventKey });
                        continue;
                    }
                    this.recentProcessedEvents.set(eventKey, Date.now());
                    setTimeout(() => this.recentProcessedEvents.delete(eventKey), 10000);
                    const connection = await database_1.prisma.hubSpotConnection.findFirst({
                        where: { hubSpotPortalId: portalId?.toString(), isConnected: true },
                    });
                    if (!connection) {
                        logger.warn('No connection found for HubSpot portal', { portalId });
                        continue;
                    }
                    // ✅ INFINITE LOOP PREVENTION: Check for recent Wix → HubSpot sync
                    const recentWixToHubspotSync = await database_1.prisma.syncLog.findFirst({
                        where: {
                            connectionId: connection.id,
                            hubSpotContactId: objectId?.toString(),
                            direction: 'wix_to_hubspot',
                            status: 'success',
                            createdAt: { gte: new Date(Date.now() - 60000) },
                        },
                    });
                    if (recentWixToHubspotSync) {
                        logger.info('🛡️ Loop prevention: skipping HubSpot event — recently synced from Wix', {
                            objectId,
                            secondsAgo: (Date.now() - recentWixToHubspotSync.createdAt.getTime()) / 1000
                        });
                        continue;
                    }
                    // Get the Wix contact ID from sync record
                    const syncRecord = await database_1.prisma.contactSync.findUnique({
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
                    // Map HubSpot property to Wix field
                    const propertyToWixField = {
                        'firstname': 'firstName',
                        'lastname': 'lastName',
                        'phone': 'phone',
                        'email': 'email'
                    };
                    const wixField = propertyToWixField[propertyName];
                    if (wixField && propertyValue) {
                        const updateData = { [wixField]: propertyValue };
                        logger.info(`🔄 Updating Wix contact ${syncRecord.wixContactId}: ${wixField} = ${propertyValue}`);
                        await this.wixService.updateContact(connection.id, syncRecord.wixContactId, updateData).catch((err) => {
                            logger.error(`Failed to update Wix contact: ${err.message}`);
                            throw err;
                        });
                        // Update sync record timestamp
                        await database_1.prisma.contactSync.update({
                            where: { id: syncRecord.id },
                            data: { lastSyncedAt: new Date() }
                        });
                        logger.info('✅ HubSpot event synced to Wix (field-level update)', {
                            objectId,
                            subscriptionType,
                            updatedField: propertyName
                        });
                    }
                    else {
                        logger.debug(`Unknown property ${propertyName} or no value, skipping`);
                    }
                }
                res.status(200).send('OK');
            }
            catch (error) {
                logger.error('❌ Error processing HubSpot webhook', error);
                res.status(500).json({ error: 'Failed to process HubSpot webhook' });
            }
        };
        // ✅ FIX: Use ONLY JWT webhooks, disable SDK handlers to prevent duplicates
        // this.registerWixEventHandlers(); // DISABLED - using JWT only
        logger.info('✅ WebhookController initialized (JWT webhooks only - SDK disabled)');
    }
    // ─────────────────────────────────────────────
    // PROCESS FORM SUBMISSION FROM JWT WEBHOOK
    // ─────────────────────────────────────────────
    async processFormSubmissionEvent(event, eventData) {
        const correlationId = (0, uuid_1.v4)();
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
            const connection = await database_1.prisma.hubSpotConnection.findFirst({
                where: { wixInstanceId: instanceId, isConnected: true },
            });
            if (!connection) {
                logger.warn('⚠️ No active HubSpot connection for form submission', { instanceId });
                return;
            }
            const contactInfo = {};
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
            if (utmParams.utm_source)
                contactInfo.hs_analytics_source = utmParams.utm_source;
            if (utmParams.utm_medium)
                contactInfo.hs_analytics_medium = utmParams.utm_medium;
            if (utmParams.utm_campaign)
                contactInfo.hs_analytics_campaign = utmParams.utm_campaign;
            if (utmParams.utm_term)
                contactInfo.hs_analytics_term = utmParams.utm_term;
            if (utmParams.utm_content)
                contactInfo.hs_analytics_content = utmParams.utm_content;
            if (utmParams.page_url)
                contactInfo.hs_analytics_original_url = utmParams.page_url;
            if (utmParams.referrer)
                contactInfo.hs_analytics_referrer = utmParams.referrer;
            let wixContactId = formData.contactId;
            let existingSync = null;
            if (wixContactId) {
                existingSync = await database_1.prisma.contactSync.findFirst({
                    where: {
                        connectionId: connection.id,
                        wixContactId: wixContactId,
                    },
                });
            }
            let result;
            if (existingSync) {
                await this.hubspotService.updateContact(connection.id, existingSync.hubSpotContactId, contactInfo);
                result = { id: existingSync.hubSpotContactId, isNew: false };
                logger.info('🔄 Updated existing HubSpot contact from form submission by ID');
            }
            else {
                // ✅ Use createOrUpdateContact to handle duplicates gracefully
                result = await this.hubspotService.createOrUpdateContact(connection.id, email, contactInfo);
                if (wixContactId && result.isNew) {
                    await database_1.prisma.contactSync.create({
                        data: {
                            connectionId: connection.id,
                            wixContactId: wixContactId,
                            hubSpotContactId: result.id,
                            lastSyncedAt: new Date(),
                            lastSyncDirection: 'wix_to_hubspot',
                            syncSource: 'form_submission',
                            correlationId: correlationId,
                        },
                    }).catch((err) => {
                        if (err.code === 'P2002') {
                            logger.info('Sync record already exists, skipping creation');
                        }
                        else {
                            throw err;
                        }
                    });
                }
            }
            await database_1.prisma.formSubmission.create({
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
            }).catch((err) => {
                if (err.code === 'P2002') {
                    logger.info('Form submission already exists, skipping');
                }
                else {
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
        }
        catch (error) {
            logger.error('❌ Error processing form submission event', error);
        }
    }
    // ─────────────────────────────────────────────
    // PROCESS CONTACT EVENT FROM JWT WEBHOOK - WITH INFINITE LOOP PREVENTION
    // ─────────────────────────────────────────────
    async processContactEventFromJWT(event, eventData, eventType) {
        const correlationId = (0, uuid_1.v4)();
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
            const connection = await database_1.prisma.hubSpotConnection.findFirst({
                where: { wixInstanceId: instanceId, isConnected: true },
            });
            if (!connection) {
                logger.warn('⚠️ No active HubSpot connection', { instanceId });
                return;
            }
            // ✅ INFINITE LOOP PREVENTION: Check for recent HubSpot → Wix sync (would cause loop)
            const recentHubspotToWixSync = await database_1.prisma.contactSync.findFirst({
                where: {
                    connectionId: connection.id,
                    wixContactId: contactId,
                    lastSyncDirection: 'hubspot_to_wix',
                    lastSyncedAt: { gte: new Date(Date.now() - 60000) },
                },
            });
            if (recentHubspotToWixSync) {
                logger.info('🛡️ Loop prevention: skipping — recently synced FROM HubSpot', { contactId });
                return;
            }
            // Extract email from the correct path
            const primaryEmail = contact?.primaryInfo?.email ||
                contact?.primaryEmail?.email ||
                contact?.info?.primaryEmail?.email ||
                contact?.info?.emails?.items?.find((e) => e.primary)?.email ||
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
            const wixContactData = {
                id: contactId,
                email: primaryEmail,
                firstName: firstName,
                lastName: lastName,
                phone: phone,
                version: contact.revision || contact.version || 0,
            };
            const hubSpotData = await this.mappingService.transformWixToHubSpot(connection.id, wixContactData);
            if (!hubSpotData.email) {
                logger.error('❌ No email after transformation');
                return;
            }
            const existingSyncRecord = await database_1.prisma.contactSync.findUnique({
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
                await this.hubspotService.updateContact(connection.id, existingSyncRecord.hubSpotContactId, hubSpotData);
                result = { id: existingSyncRecord.hubSpotContactId, isNew: false };
            }
            else {
                // ✅ Use createOrUpdateContact to handle 409 gracefully
                logger.info(`🆕 [JWT] Creating/updating HubSpot contact for: ${primaryEmail}`);
                result = await this.hubspotService.createOrUpdateContact(connection.id, primaryEmail, hubSpotData);
            }
            // ✅ Use upsert to avoid P2002 unique constraint errors
            await database_1.prisma.contactSync.upsert({
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
            }).catch((err) => {
                if (err.code === 'P2002') {
                    logger.info('Sync record already exists, skipping upsert', { contactId, hubSpotId: result.id });
                }
                else {
                    throw err;
                }
            });
            // ✅ Create sync log but handle duplicates gracefully
            await database_1.prisma.syncLog.create({
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
            }).catch((err) => {
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
        }
        catch (error) {
            logger.error(`❌ Error processing contact ${eventType} from JWT`, error);
            // Log failure but don't throw - prevent crash
            await database_1.prisma.syncLog.create({
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
}
exports.WebhookController = WebhookController;
//# sourceMappingURL=webhook.controller.js.map