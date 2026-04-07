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
// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const PUBLIC_KEY = process.env.WIX_PUBLIC_KEY?.replace(/\\n/g, '\n').trim() || '';
const APP_ID = process.env.WIX_APP_ID || '';
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
        this.processingLocks = new Map();
        // ─────────────────────────────────────────────
        // UNIFIED WIX WEBHOOK HANDLER
        // ─────────────────────────────────────────────
        this.handleWixWebhook = async (req, res) => {
            logger.info('📩 Wix webhook HTTP POST received');
            res.status(200).send();
            try {
                const decodedPayload = jsonwebtoken_1.default.verify(req.body, PUBLIC_KEY);
                const event = JSON.parse(decodedPayload.data);
                const eventData = JSON.parse(event.data);
                console.log('\n🔍 ========== RAW CONTACT EVENT DATA ==========');
                console.log('📦 Full decoded payload:', JSON.stringify(decodedPayload, null, 2));
                console.log('📋 Event object:', JSON.stringify(event, null, 2));
                console.log('📄 Event data (contact):', JSON.stringify(eventData, null, 2));
                console.log('🔍 =============================================\n');
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
                    case "com.wixpress.crm.v1.ContactCreatedEvent":
                        logger.info('👤 Processing contact created event via JWT (legacy)');
                        await this.processContactEventFromJWT(event, eventData, 'created');
                        break;
                    case "com.wixpress.crm.v1.ContactUpdatedEvent":
                        logger.info('👤 Processing contact updated event via JWT (legacy)');
                        await this.processContactEventFromJWT(event, eventData, 'updated');
                        break;
                    default:
                        logger.info(`Received unknown event type: ${event.eventType}`);
                        break;
                }
            }
            catch (err) {
                logger.info('Not a JWT payload or JWT verification failed, trying Wix SDK processing...');
                try {
                    await wixClient.webhooks.process(req.body);
                    logger.info('✅ wixClient.webhooks.process() completed');
                }
                catch (sdkError) {
                    logger.error('❌ Error processing webhook:', sdkError);
                }
            }
        };
        // ─────────────────────────────────────────────
        // HUBSPOT → WIX WEBHOOK
        // ─────────────────────────────────────────────
        this.handleHubSpotWebhook = async (req, res) => {
            logger.info('🔄 HubSpot webhook received (HubSpot → Wix)');
            try {
                const events = Array.isArray(req.body) ? req.body : [req.body];
                for (const event of events) {
                    const { portalId, subscriptionType, objectId } = event;
                    const connection = await database_1.prisma.hubSpotConnection.findFirst({
                        where: { hubSpotPortalId: portalId?.toString(), isConnected: true },
                    });
                    if (!connection) {
                        logger.warn('No connection found for HubSpot portal', { portalId });
                        continue;
                    }
                    const recentWixSync = await database_1.prisma.syncLog.findFirst({
                        where: {
                            connectionId: connection.id,
                            hubSpotContactId: objectId?.toString(),
                            direction: 'wix_to_hubspot',
                            status: 'success',
                            createdAt: { gte: new Date(Date.now() - 60000) },
                        },
                    });
                    if (recentWixSync) {
                        logger.info('🛡️ Loop prevention: skipping HubSpot event — recently synced from Wix', {
                            objectId,
                        });
                        continue;
                    }
                    if (subscriptionType === 'contact.creation' || subscriptionType === 'contact.propertyChange') {
                        const hubSpotContact = await this.hubspotService.getContact(connection.id, objectId?.toString());
                        await this.syncService.syncHubSpotContactToWix(connection.id, objectId?.toString(), hubSpotContact, (0, uuid_1.v4)());
                        logger.info('✅ HubSpot event synced to Wix', { objectId, subscriptionType });
                    }
                }
                res.status(200).send('OK');
            }
            catch (error) {
                logger.error('❌ Error processing HubSpot webhook', error);
                res.status(500).json({ error: 'Failed to process HubSpot webhook' });
            }
        };
        this.registerWixEventHandlers();
    }
    registerWixEventHandlers() {
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
    // ============================================================
    // APPROACH 1: Query Form Submissions API by contactId
    // Reads hidden field values from form submissions directly
    // ============================================================
    async getFormSubmissionByContactId(contactId, accessToken, wixInstanceId) {
        try {
            const response = await fetch(`https://www.wixapis.com/forms/v4/submissions/query`, {
                method: 'POST',
                headers: {
                    'Authorization': accessToken,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: {
                        filter: {
                            contactId: { $eq: contactId },
                        },
                        sort: [{ fieldName: 'createdDate', order: 'DESC' }],
                        paging: { limit: 1 },
                    },
                }),
            });
            const data = await response.json();
            const submission = data.submissions?.[0];
            if (!submission)
                return null;
            const fields = submission.submissions ?? {};
            console.log('🔍 [Approach 1] Form submission hidden fields:', {
                fieldKeys: Object.keys(fields),
                submissionId: submission.id,
                formId: submission.formId
            });
            return {
                submissionId: submission.id,
                formId: submission.formId,
                contactId: submission.contactId,
                utmSource: fields['utm_source'] ?? fields['utmSource'] ?? null,
                utmMedium: fields['utm_medium'] ?? fields['utmMedium'] ?? null,
                utmCampaign: fields['utm_campaign'] ?? fields['utmCampaign'] ?? null,
                utmTerm: fields['utm_term'] ?? fields['utmTerm'] ?? null,
                utmContent: fields['utm_content'] ?? fields['utmContent'] ?? null,
                pageUrl: fields['page_url'] ?? fields['pageUrl'] ?? null,
                referrer: fields['referrer'] ?? null,
                rawFields: fields,
            };
        }
        catch (error) {
            logger.error('[Approach 1] Failed to query form submissions:', error);
            return null;
        }
    }
    // ============================================================
    // APPROACH 2: Read from info.extendedFields on the Contact
    // ============================================================
    async getContactWithAttribution(contactId, accessToken, wixInstanceId) {
        try {
            const response = await fetch(`https://www.wixapis.com/contacts/v4/contacts/${contactId}`, {
                headers: {
                    'Authorization': accessToken,
                    'Content-Type': 'application/json'
                },
            });
            const data = await response.json();
            const contact = data.contact;
            if (!contact)
                return null;
            const ext = contact.info?.extendedFields ?? {};
            console.log('🔍 [Approach 2] Contact extended fields:', {
                extendedFieldKeys: Object.keys(ext),
                allExtendedFields: ext
            });
            return {
                name: contact.info?.name?.full,
                email: contact.primaryInfo?.email,
                utmSource: ext['attribution.utmSource'] ?? ext['custom.utmSource'] ?? ext['utm_source'] ?? null,
                utmMedium: ext['attribution.utmMedium'] ?? ext['custom.utmMedium'] ?? ext['utm_medium'] ?? null,
                utmCampaign: ext['attribution.utmCampaign'] ?? ext['custom.utmCampaign'] ?? ext['utm_campaign'] ?? null,
                utmTerm: ext['attribution.utmTerm'] ?? ext['custom.utmTerm'] ?? ext['utm_term'] ?? null,
                utmContent: ext['attribution.utmContent'] ?? ext['custom.utmContent'] ?? ext['utm_content'] ?? null,
                pageUrl: ext['attribution.pageUrl'] ?? ext['custom.pageUrl'] ?? ext['page_url'] ?? null,
                referrer: ext['attribution.referrer'] ?? ext['custom.referrer'] ?? null,
                _allExtendedFields: ext,
            };
        }
        catch (error) {
            logger.error('[Approach 2] Failed to get contact attribution:', error);
            return null;
        }
    }
    // ============================================================
    // APPROACH 3: Combined Orchestrator
    // ============================================================
    async getCombinedAttributionData(contactId, accessToken, wixInstanceId) {
        console.log(`🔍 [Approach 3] Fetching attribution data for contact: ${contactId}`);
        const [submissionData, contactData] = await Promise.allSettled([
            this.getFormSubmissionByContactId(contactId, accessToken, wixInstanceId),
            this.getContactWithAttribution(contactId, accessToken, wixInstanceId),
        ]);
        const submission = submissionData.status === 'fulfilled' ? submissionData.value : null;
        const contact = contactData.status === 'fulfilled' ? contactData.value : null;
        console.log('📊 [Approach 3] Results:', {
            hasSubmissionData: !!submission,
            hasContactData: !!contact,
            submissionFields: submission?.rawFields ? Object.keys(submission.rawFields) : [],
            contactExtendedFields: contact?._allExtendedFields ? Object.keys(contact._allExtendedFields) : []
        });
        return {
            contactId,
            contact: {
                name: contact?.name ?? null,
                email: contact?.email ?? null,
            },
            attribution: {
                source: submission?.utmSource ?? contact?.utmSource ?? null,
                medium: submission?.utmMedium ?? contact?.utmMedium ?? null,
                campaign: submission?.utmCampaign ?? contact?.utmCampaign ?? null,
                term: submission?.utmTerm ?? contact?.utmTerm ?? null,
                content: submission?.utmContent ?? contact?.utmContent ?? null,
                pageUrl: submission?.pageUrl ?? contact?.pageUrl ?? null,
                referrer: submission?.referrer ?? contact?.referrer ?? null,
            },
            _debug: {
                submissionId: submission?.submissionId,
                formId: submission?.formId,
                allContactExtendedFields: contact?._allExtendedFields,
                rawFormFields: submission?.rawFields,
            },
        };
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
            let attributionData = null;
            let utmParams = {
                utm_source: null,
                utm_medium: null,
                utm_campaign: null,
                utm_term: null,
                utm_content: null,
                page_url: null,
                referrer: null,
                timestamp: new Date().toISOString(),
                wix_contact_id: formData.contactId || null,
            };
            if (formData.utm_source || formData.utmSource) {
                utmParams.utm_source = formData.utm_source || formData.utmSource;
                utmParams.utm_medium = formData.utm_medium || formData.utmMedium;
                utmParams.utm_campaign = formData.utm_campaign || formData.utmCampaign;
                utmParams.utm_term = formData.utm_term || formData.utmTerm;
                utmParams.utm_content = formData.utm_content || formData.utmContent;
                utmParams.page_url = formData.pageUrl || formData.url;
                utmParams.referrer = formData.referrer;
                console.log('📊 [Direct] UTM from form event:', utmParams);
            }
            if (formData.contactId && connection.wixAccessToken) {
                try {
                    attributionData = await this.getCombinedAttributionData(formData.contactId, connection.wixAccessToken, instanceId);
                    if (attributionData?.attribution) {
                        utmParams = {
                            utm_source: utmParams.utm_source || attributionData.attribution.source,
                            utm_medium: utmParams.utm_medium || attributionData.attribution.medium,
                            utm_campaign: utmParams.utm_campaign || attributionData.attribution.campaign,
                            utm_term: utmParams.utm_term || attributionData.attribution.term,
                            utm_content: utmParams.utm_content || attributionData.attribution.content,
                            page_url: utmParams.page_url || attributionData.attribution.pageUrl,
                            referrer: utmParams.referrer || attributionData.attribution.referrer,
                            timestamp: new Date().toISOString(),
                            wix_contact_id: formData.contactId,
                        };
                        console.log('📊 [Combined] UTM after merging approaches:', utmParams);
                    }
                }
                catch (error) {
                    logger.error('Failed to get combined attribution data:', error);
                }
            }
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
            logger.info('📊 Form field data extracted:', {
                email,
                firstName,
                lastName,
                phone,
                company,
            });
            logger.info('📊 Final UTM Attribution captured:', utmParams);
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
                logger.info('🔄 Updated existing HubSpot contact from form submission');
            }
            else {
                result = await this.hubspotService.createOrUpdateContact(connection.id, email, contactInfo);
                if (wixContactId) {
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
                    });
                }
            }
            const savedSubmission = await database_1.prisma.formSubmission.create({
                data: {
                    connectionId: connection.id,
                    wixFormId: formData.formName || formData.formId || 'unknown',
                    wixFormName: formData.formName || null,
                    hubSpotContactId: result.id,
                    formData: {
                        formName: formData.formName,
                        submissionData: formData.submissionData,
                        submissionTime: formData.submissionTime,
                        contactId: formData.contactId,
                    },
                    utmParams: {
                        ...utmParams,
                        _debug: attributionData?._debug || null,
                    },
                    syncedToHubSpot: true,
                    hubSpotSubmissionId: result.id,
                    utmSource: utmParams.utm_source,
                    utmMedium: utmParams.utm_medium,
                    utmCampaign: utmParams.utm_campaign,
                    utmTerm: utmParams.utm_term,
                    utmContent: utmParams.utm_content,
                    pageUrl: utmParams.page_url,
                    referrer: utmParams.referrer,
                    leadStatus: 'new',
                    leadScore: 0,
                    submittedAt: new Date(),
                },
            });
            logger.info('✅ Form submission SAVED to database!', {
                id: savedSubmission.id,
                contactId: result.id,
                isNew: result.isNew,
                email,
                wixContactId,
                formName: formData.formName,
                utmSource: utmParams.utm_source,
                utmCampaign: utmParams.utm_campaign,
                approachesUsed: {
                    directFields: !!(formData.utm_source || formData.utmSource),
                    combinedApproach: !!attributionData,
                    hasFormSubmissionAPI: !!attributionData?._debug?.submissionId,
                    hasExtendedFields: !!attributionData?._debug?.allContactExtendedFields
                },
                durationMs: Date.now() - startTime,
                correlationId,
            });
        }
        catch (error) {
            logger.error('❌ Error processing form submission event', error);
        }
    }
    // ─────────────────────────────────────────────
    // PROCESS CONTACT EVENT FROM JWT WEBHOOK - FIXED
    // ─────────────────────────────────────────────
    async processContactEventFromJWT(event, eventData, eventType) {
        const correlationId = (0, uuid_1.v4)();
        try {
            const instanceId = event.instanceId;
            let contact = eventData.contact || eventData;
            const contactId = contact.id || contact._id;
            logger.info(`🔄 Processing contact ${eventType} from JWT`, {
                correlationId,
                instanceId,
                contactId,
            });
            const connection = await database_1.prisma.hubSpotConnection.findFirst({
                where: { wixInstanceId: instanceId, isConnected: true },
            });
            if (!connection) {
                logger.warn('⚠️ No active HubSpot connection', { instanceId });
                return;
            }
            if (contact.updatedEvent?.currentEntity)
                contact = contact.updatedEvent.currentEntity;
            if (contact.createdEvent?.currentEntity)
                contact = contact.createdEvent.currentEntity;
            const isFromWixForms = contact.source?.sourceType === 'WIX_FORMS';
            const isFormActivity = contact.lastActivity?.activityType === 'FORM_SUBMITTED';
            const isFormDescription = contact.lastActivity?.description === 'Submitted a form' ||
                contact.lastActivity?.description?.toLowerCase().includes('form');
            const hasFormIcon = contact.lastActivity?.icon?.name === 'WixForms';
            const isFromForm = isFromWixForms || isFormActivity || isFormDescription || hasFormIcon;
            let attributionData = null;
            if (contactId && connection.wixAccessToken) {
                try {
                    attributionData = await this.getCombinedAttributionData(contactId, connection.wixAccessToken, instanceId);
                    console.log('📊 [Contact Event] Attribution data retrieved:', {
                        hasAttribution: !!attributionData,
                        utmSource: attributionData?.attribution?.source,
                        utmCampaign: attributionData?.attribution?.campaign,
                        debugInfo: attributionData?._debug
                    });
                }
                catch (error) {
                    logger.error('Failed to get attribution data for contact:', error);
                }
            }
            if (isFromForm) {
                logger.info('📝 This contact came from a FORM SUBMISSION!', {
                    sourceType: contact.source?.sourceType,
                    activityType: contact.lastActivity?.activityType,
                    description: contact.lastActivity?.description,
                    iconName: contact.lastActivity?.icon?.name,
                    utmFromAttribution: attributionData?.attribution,
                });
            }
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
            const primaryEmail = contact.primaryEmail?.email ||
                contact.primaryInfo?.email ||
                contact.info?.emails?.items?.find((e) => e.primary)?.email;
            if (!primaryEmail) {
                logger.warn('⚠️ No email on contact — skipping sync', { contactId });
                return;
            }
            const firstName = contact.info?.name?.first || null;
            const lastName = contact.info?.name?.last || null;
            const phone = contact.primaryPhone?.phone || contact.primaryInfo?.phone || null;
            const wixContactData = {
                id: contactId,
                email: primaryEmail,
                firstName: firstName,
                lastName: lastName,
                phone: phone,
                version: contact.revision || 0,
            };
            const hubSpotData = await this.mappingService.transformWixToHubSpot(connection.id, wixContactData);
            if (attributionData?.attribution) {
                if (attributionData.attribution.source)
                    hubSpotData.hs_analytics_source = attributionData.attribution.source;
                if (attributionData.attribution.medium)
                    hubSpotData.hs_analytics_medium = attributionData.attribution.medium;
                if (attributionData.attribution.campaign)
                    hubSpotData.hs_analytics_campaign = attributionData.attribution.campaign;
                if (attributionData.attribution.term)
                    hubSpotData.hs_analytics_term = attributionData.attribution.term;
                if (attributionData.attribution.content)
                    hubSpotData.hs_analytics_content = attributionData.attribution.content;
                if (attributionData.attribution.pageUrl)
                    hubSpotData.hs_analytics_original_url = attributionData.attribution.pageUrl;
                if (attributionData.attribution.referrer)
                    hubSpotData.hs_analytics_referrer = attributionData.attribution.referrer;
            }
            if (!hubSpotData.email) {
                logger.error('❌ No email after transformation');
                return;
            }
            // ============================================================
            // FIX: Check for existing sync record BEFORE calling HubSpot
            // ============================================================
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
                // UPDATE existing HubSpot contact by ID
                logger.info(`🔄 [JWT] Updating existing HubSpot contact: ${existingSyncRecord.hubSpotContactId}`);
                await this.hubspotService.updateContact(connection.id, existingSyncRecord.hubSpotContactId, hubSpotData);
                result = { id: existingSyncRecord.hubSpotContactId, isNew: false };
            }
            else {
                // No existing sync record - search by email or create
                logger.info(`🆕 [JWT] No sync record found, creating/updating by email`);
                result = await this.hubspotService.createOrUpdateContact(connection.id, hubSpotData.email, hubSpotData);
            }
            // Handle unique constraint for sync record
            const existingSyncByHubSpot = await database_1.prisma.contactSync.findFirst({
                where: {
                    connectionId: connection.id,
                    hubSpotContactId: result.id,
                },
            });
            if (existingSyncByHubSpot) {
                await database_1.prisma.contactSync.update({
                    where: { id: existingSyncByHubSpot.id },
                    data: {
                        wixContactId: contactId,
                        lastSyncedAt: new Date(),
                        lastSyncDirection: 'wix_to_hubspot',
                        syncSource: 'wix_jwt',
                        correlationId: correlationId,
                        wixVersion: contact.revision || 0,
                        updatedAt: new Date(),
                    },
                });
            }
            else {
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
                });
            }
            if (isFromForm && attributionData) {
                try {
                    const savedForm = await database_1.prisma.formSubmission.create({
                        data: {
                            connectionId: connection.id,
                            wixFormId: contact.source?.wixAppId || contact.source?.appId || attributionData._debug?.formId || 'unknown',
                            wixFormName: contact.lastActivity?.description || 'Form Submission',
                            hubSpotContactId: result.id,
                            formData: contact,
                            utmParams: {
                                ...attributionData.attribution,
                                _debug: attributionData._debug
                            },
                            syncedToHubSpot: true,
                            hubSpotSubmissionId: result.id,
                            utmSource: attributionData.attribution.source,
                            utmMedium: attributionData.attribution.medium,
                            utmCampaign: attributionData.attribution.campaign,
                            utmTerm: attributionData.attribution.term,
                            utmContent: attributionData.attribution.content,
                            pageUrl: attributionData.attribution.pageUrl,
                            referrer: attributionData.attribution.referrer,
                            leadStatus: 'new',
                            leadScore: 0,
                            submittedAt: contact.createdDate || new Date(),
                        },
                    });
                    logger.info('✅ Form submission saved from contact event with attribution!', {
                        formSubmissionId: savedForm.id,
                        email: primaryEmail,
                        utmSource: attributionData.attribution.source,
                        utmCampaign: attributionData.attribution.campaign,
                    });
                }
                catch (formError) {
                    if (formError.code === 'P2002') {
                        logger.info('📝 Form submission already exists, skipping duplicate');
                    }
                    else {
                        logger.error('❌ Failed to save form submission from contact event:', formError.message);
                    }
                }
            }
            logger.info(`✅ Contact ${eventType} synced from JWT`, {
                wixContactId: contactId,
                hubSpotContactId: result.id,
                email: primaryEmail,
                isFromForm: isFromForm,
                hasUtmData: !!attributionData?.attribution?.source,
                wasUpdate: !!existingSyncRecord,
            });
        }
        catch (error) {
            logger.error(`❌ Error processing contact ${eventType} from JWT`, error);
        }
    }
    // ─────────────────────────────────────────────
    // PROCESS WIX CONTACT EVENT (from SDK) - FIXED
    // ─────────────────────────────────────────────
    async processWixContactEvent(rawEvent, eventType) {
        const correlationId = (0, uuid_1.v4)();
        const startTime = Date.now();
        try {
            let parsedEvent;
            try {
                parsedEvent =
                    typeof rawEvent.event === 'string'
                        ? JSON.parse(rawEvent.event)
                        : rawEvent;
            }
            catch (parseError) {
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
            const connection = await database_1.prisma.hubSpotConnection.findFirst({
                where: {
                    wixInstanceId: instanceId,
                    isConnected: true,
                },
            });
            if (!connection) {
                logger.warn('⚠️ No active HubSpot connection', { instanceId });
                return;
            }
            const recentHubspotToWixSync = await database_1.prisma.contactSync.findFirst({
                where: {
                    connectionId: connection.id,
                    wixContactId: contactId,
                    lastSyncDirection: 'hubspot_to_wix',
                    lastSyncedAt: {
                        gte: new Date(Date.now() - 60000),
                    },
                },
            });
            if (recentHubspotToWixSync) {
                logger.info('🛡️ Loop prevention: skipping — recently synced FROM HubSpot', { contactId });
                return;
            }
            const duplicateProcessing = await database_1.prisma.syncLog.findFirst({
                where: {
                    connectionId: connection.id,
                    wixContactId: contactId,
                    direction: 'wix_to_hubspot',
                    status: 'success',
                    createdAt: {
                        gte: new Date(Date.now() - 10000),
                    },
                },
            });
            if (duplicateProcessing) {
                logger.info('🛡️ Loop prevention: duplicate webhook processing detected', { contactId });
                return;
            }
            const contactVersion = contact?.revision || contact?.version || 0;
            const existingSync = await database_1.prisma.contactSync.findUnique({
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
            const existingCorrelationId = await database_1.prisma.contactSync.findUnique({
                where: { correlationId },
            });
            if (existingCorrelationId) {
                logger.info('🛡️ Loop prevention: duplicate correlationId detected', { correlationId });
                return;
            }
            const lockKey = `wix-${connection.id}-${contactId}`;
            if (this.processingLocks.get(lockKey)) {
                logger.info('🛡️ Loop prevention: already processing this contact', { contactId });
                return;
            }
            this.processingLocks.set(lockKey, true);
            try {
                const primaryEmail = contact?.primaryInfo?.email ||
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
                const wixContactData = {
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
                const hubSpotData = await this.mappingService.transformWixToHubSpot(connection.id, wixContactData);
                if (!hubSpotData.email) {
                    logger.error('❌ No email after transformation');
                    return;
                }
                // ============================================================
                // FIX: Check for existing sync record BEFORE calling HubSpot
                // ============================================================
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
                    // UPDATE existing HubSpot contact by ID
                    logger.info(`🔄 [SDK] Updating existing HubSpot contact: ${existingSyncRecord.hubSpotContactId}`);
                    await this.hubspotService.updateContact(connection.id, existingSyncRecord.hubSpotContactId, hubSpotData);
                    result = { id: existingSyncRecord.hubSpotContactId, isNew: false };
                }
                else {
                    // No existing sync record - search by email or create
                    logger.info(`🆕 [SDK] No sync record found, creating/updating by email`);
                    result = await this.hubspotService.createOrUpdateContact(connection.id, hubSpotData.email, hubSpotData);
                }
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
            }
            finally {
                setTimeout(() => this.processingLocks.delete(lockKey), 5000);
            }
        }
        catch (error) {
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
            logger.error(`❌ Error processing Wix contact ${eventType}`, {
                error: error instanceof Error ? error.message : 'Unknown error',
                durationMs: Date.now() - startTime,
                correlationId,
            });
        }
    }
}
exports.WebhookController = WebhookController;
//# sourceMappingURL=webhook.controller.js.map