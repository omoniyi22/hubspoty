"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HubSpotService = void 0;
// src/services/hubspot.service.ts
const axios_1 = __importDefault(require("axios"));
const database_1 = require("../config/database");
class HubSpotService {
    constructor() {
        this.baseURL = 'https://api.hubapi.com';
    }
    static getInstance() {
        if (!HubSpotService.instance) {
            HubSpotService.instance = new HubSpotService();
        }
        return HubSpotService.instance;
    }
    async getAccessToken(connectionId) {
        const connection = await database_1.prisma.hubSpotConnection.findUnique({
            where: { id: connectionId }
        });
        if (!connection) {
            throw new Error(`HubSpot connection not found for connectionId: ${connectionId}`);
        }
        // Proactively refresh 60 seconds before expiry to avoid using a token
        // that expires mid-request
        const sixtySeconds = 60 * 1000;
        if (new Date().getTime() >= connection.expiresAt.getTime() - sixtySeconds) {
            return await this.refreshAccessToken(connectionId, connection.refreshToken);
        }
        return connection.accessToken;
    }
    async refreshAccessToken(connectionId, refreshToken) {
        // HubSpot token refresh uses application/x-www-form-urlencoded, NOT JSON.
        // Endpoint: POST https://api.hubapi.com/oauth/v1/token
        // (v3 was released Jan 2026 at api.hubspot.com/oauth/v3/token but v1
        // remains stable and is what existing stored tokens were issued against)
        const params = new URLSearchParams();
        params.append('grant_type', 'refresh_token');
        params.append('client_id', process.env.HUBSPOT_CLIENT_ID);
        params.append('client_secret', process.env.HUBSPOT_CLIENT_SECRET);
        params.append('refresh_token', refreshToken);
        let data;
        try {
            const response = await axios_1.default.post(`${this.baseURL}/oauth/v1/token`, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            data = response.data;
        }
        catch (error) {
            const status = error?.response?.status;
            const message = error?.response?.data?.message || error?.response?.data?.error_description || error.message;
            throw new Error(`HubSpot token refresh failed (${status}): ${message}. ` +
                `Connection ${connectionId} may need to be re-authorized.`);
        }
        await database_1.prisma.hubSpotConnection.update({
            where: { id: connectionId },
            data: {
                accessToken: data.access_token,
                // HubSpot may or may not rotate the refresh token — persist whatever
                // is returned, falling back to the existing one if absent
                refreshToken: data.refresh_token ?? refreshToken,
                expiresAt: new Date(Date.now() + data.expires_in * 1000),
                scope: data.scope,
            },
        });
        return data.access_token;
    }
    async createContact(connectionId, contactData) {
        const accessToken = await this.getAccessToken(connectionId);
        const response = await axios_1.default.post(`${this.baseURL}/crm/v3/objects/contacts`, { properties: contactData }, { headers: { Authorization: `Bearer ${accessToken}` } });
        return response.data;
    }
    async updateContact(connectionId, contactId, contactData) {
        const accessToken = await this.getAccessToken(connectionId);
        await axios_1.default.patch(`${this.baseURL}/crm/v3/objects/contacts/${contactId}`, { properties: contactData }, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
    async getContact(connectionId, contactId) {
        const accessToken = await this.getAccessToken(connectionId);
        const response = await axios_1.default.get(`${this.baseURL}/crm/v3/objects/contacts/${contactId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
        return response.data;
    }
    async searchContactByEmail(connectionId, email) {
        const accessToken = await this.getAccessToken(connectionId);
        const response = await axios_1.default.post(`${this.baseURL}/crm/v3/objects/contacts/search`, {
            filterGroups: [{
                    filters: [{
                            propertyName: 'email',
                            operator: 'EQ',
                            value: email,
                        }],
                }],
            // Always request the properties the sync service needs so they are
            // present on the returned object without a separate getContact call
            properties: ['email', 'firstname', 'lastname', 'phone', 'hs_updatedate'],
        }, { headers: { Authorization: `Bearer ${accessToken}` } });
        return response.data.results?.[0] ?? null;
    }
    async createOrUpdateContact(connectionId, email, contactData) {
        try {
            // ALWAYS search for existing contact by email FIRST
            const existingContact = await this.searchContactByEmail(connectionId, email);
            if (existingContact) {
                // Contact exists - UPDATE it
                console.log(`📝 Updating existing HubSpot contact: ${existingContact.id}`);
                await this.updateContact(connectionId, existingContact.id, contactData);
                return { id: existingContact.id, isNew: false };
            }
            // No existing contact - CREATE new one
            console.log(`🆕 Creating new HubSpot contact for: ${email}`);
            const newContact = await this.createContact(connectionId, {
                ...contactData,
                email,
            });
            return { id: newContact.id, isNew: true };
        }
        catch (error) {
            // Handle race condition: contact was created between search and create
            if (error.response?.status === 409) {
                const match = error.response?.data?.message?.match(/Existing ID: (\d+)/);
                if (match) {
                    const existingId = match[1];
                    console.log(`📝 Contact created by another request, updating ID: ${existingId}`);
                    await this.updateContact(connectionId, existingId, contactData);
                    return { id: existingId, isNew: false };
                }
            }
            throw error;
        }
    }
    async subscribeToWebhooks(connectionId, portalId) {
        const developerApiKey = process.env.HUBSPOT_DEVELOPER_API_KEY;
        const appId = process.env.HUBSPOT_APP_ID;
        if (!developerApiKey) {
            console.error('❌ HUBSPOT_DEVELOPER_API_KEY not set. Webhook subscriptions skipped.');
            return;
        }
        if (!appId) {
            console.error('❌ HUBSPOT_APP_ID not set. Webhook subscriptions skipped.');
            return;
        }
        console.log(`📡 Setting up webhook subscriptions for portal ${portalId} with app ID ${appId}`);
        const subscriptions = [
            { eventType: 'contact.creation', active: true },
            { eventType: 'contact.propertyChange', propertyName: 'email', active: true },
            { eventType: 'contact.propertyChange', propertyName: 'firstname', active: true },
            { eventType: 'contact.propertyChange', propertyName: 'lastname', active: true },
        ];
        let existingSubscriptions = [];
        try {
            const existing = await axios_1.default.get(`${this.baseURL}/webhooks/v3/${appId}/subscriptions?hapikey=${developerApiKey}`);
            existingSubscriptions = existing.data?.results || existing.data || [];
            console.log(`  ℹ️  Found ${existingSubscriptions.length} existing webhook subscription(s)`);
        }
        catch {
            console.warn('  ⚠️  Could not fetch existing subscriptions, proceeding anyway');
        }
        let successCount = 0;
        let skippedCount = 0;
        let failCount = 0;
        for (const subscription of subscriptions) {
            // Parens around the ternary ensure && binds correctly — without them
            // the ternary runs first and propertyName comparisons are never evaluated
            const alreadyExists = existingSubscriptions.some((s) => s.eventType === subscription.eventType &&
                (subscription.propertyName
                    ? s.propertyName === subscription.propertyName
                    : true));
            if (alreadyExists) {
                console.log(`  ⏭️  Skipping (already exists): ${subscription.eventType}` +
                    `${subscription.propertyName ? ` (${subscription.propertyName})` : ''}`);
                skippedCount++;
                continue;
            }
            try {
                console.log(`  → Creating subscription: ${subscription.eventType}` +
                    `${subscription.propertyName ? ` (${subscription.propertyName})` : ''}`);
                await axios_1.default.post(`${this.baseURL}/webhooks/v3/${appId}/subscriptions?hapikey=${developerApiKey}`, subscription, { headers: { 'Content-Type': 'application/json' } });
                console.log(`  ✅ Successfully created: ${subscription.eventType}`);
                successCount++;
            }
            catch (error) {
                failCount++;
                console.error(`  ❌ Failed to create subscription ${subscription.eventType}:`);
                if (error.response) {
                    console.error(`     Status:         ${error.response.status}`);
                    console.error(`     Message:        ${error.response.data?.message || error.message}`);
                    console.error(`     Correlation ID: ${error.response.data?.correlationId}`);
                }
                else {
                    console.error(`     Error: ${error.message}`);
                }
            }
        }
        console.log(`📊 Webhook setup complete: ${successCount} created, ${skippedCount} skipped, ${failCount} failed`);
        if (failCount > 0) {
            console.log(`💡 Tip: Configure webhooks manually at https://app.hubspot.com/developer/148173654/apps`);
        }
    }
    async testConnection(connectionId) {
        try {
            const accessToken = await this.getAccessToken(connectionId);
            const response = await axios_1.default.get(`${this.baseURL}/crm/v3/objects/contacts?limit=1`, { headers: { Authorization: `Bearer ${accessToken}` } });
            return response.status === 200;
        }
        catch (error) {
            console.error('Connection test failed:', error);
            return false;
        }
    }
    async getWebhookSubscriptions() {
        const developerApiKey = process.env.HUBSPOT_DEVELOPER_API_KEY;
        const appId = process.env.HUBSPOT_APP_ID;
        if (!developerApiKey || !appId) {
            console.error('❌ HUBSPOT_DEVELOPER_API_KEY or HUBSPOT_APP_ID not set');
            return [];
        }
        try {
            const response = await axios_1.default.get(`${this.baseURL}/webhooks/v3/${appId}/subscriptions?hapikey=${developerApiKey}`);
            return response.data?.results || response.data || [];
        }
        catch (error) {
            console.error('Failed to get webhook subscriptions:', error);
            return [];
        }
    }
}
exports.HubSpotService = HubSpotService;
//# sourceMappingURL=hubspot.service.js.map