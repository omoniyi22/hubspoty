"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WixService = void 0;
// src/services/wix.service.ts
const axios_1 = __importDefault(require("axios"));
const database_1 = require("../config/database");
class WixService {
    constructor() {
        this.contactsBaseURL = 'https://www.wixapis.com/contacts/v4/contacts';
        this.oauthBaseURL = 'https://www.wixapis.com/oauth2/token';
        this.tokenCache = new Map();
    }
    static getInstance() {
        if (!WixService.instance) {
            WixService.instance = new WixService();
        }
        return WixService.instance;
    }
    // ---------------------------------------------------------------------------
    // Authentication
    // ---------------------------------------------------------------------------
    async getWixToken(instanceId) {
        const cached = this.tokenCache.get(instanceId);
        const fiveMinutes = 5 * 60 * 1000;
        if (cached && cached.expiresAt.getTime() - Date.now() > fiveMinutes) {
            console.log('[WixAuth] ✅ Using cached token', {
                instanceId,
                expiresAt: cached.expiresAt.toISOString(),
                expiresInMs: cached.expiresAt.getTime() - Date.now(),
            });
            return cached.accessToken;
        }
        const appId = process.env.WIX_APP_ID;
        const appSecret = process.env.WIX_APP_SECRET;
        console.log('[WixAuth] 🔎 Credential check', {
            WIX_APP_ID_set: !!appId,
            WIX_APP_SECRET_set: !!appSecret,
            WIX_APP_ID_preview: appId ? `${appId.slice(0, 8)}...${appId.slice(-4)}` : 'MISSING',
            WIX_APP_SECRET_preview: appSecret ? `${appSecret.slice(0, 8)}...${appSecret.slice(-4)}` : 'MISSING',
            instanceId,
        });
        if (!appId || !appSecret) {
            console.error('[WixAuth] ❌ Missing environment variables — set WIX_APP_ID and WIX_APP_SECRET in your .env');
            throw new Error('WIX_APP_ID or WIX_APP_SECRET environment variable is not set');
        }
        let connectionInfo = await database_1.prisma.hubSpotConnection.findUnique({
            where: { id: instanceId }
        });
        instanceId = connectionInfo.wixInstanceId;
        const requestBody = {
            grant_type: 'client_credentials',
            client_id: appId,
            client_secret: appSecret,
            instance_id: instanceId,
        };
        console.log('[WixAuth] 🔐 Requesting new Wix access token', {
            url: this.oauthBaseURL,
            grant_type: requestBody.grant_type,
            client_id: requestBody.client_id,
            instance_id: requestBody.instance_id,
            client_secret_length: appSecret.length,
        });
        try {
            const response = await axios_1.default.post(this.oauthBaseURL, requestBody, {
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            console.log('[WixAuth] ✅ Token request succeeded', {
                status: response.status,
                hasAccessToken: !!response.data?.access_token,
                tokenType: response.data?.token_type,
                expiresIn: response.data?.expires_in,
            });
            const tokenData = typeof response.data?.body === 'string'
                ? JSON.parse(response.data.body)
                : response.data;
            const accessToken = tokenData.access_token;
            const expiresIn = tokenData.expires_in ?? 14400;
            const expiresAt = new Date(Date.now() + expiresIn * 1000);
            if (!accessToken) {
                console.error('[WixAuth] ❌ Response missing access_token', {
                    tokenDataKeys: Object.keys(tokenData),
                    tokenData: JSON.stringify(tokenData),
                });
                throw new Error(`Wix OAuth response missing access_token: ${JSON.stringify(tokenData)}`);
            }
            this.tokenCache.set(instanceId, { accessToken, expiresAt });
            console.log('[WixAuth] 💾 Token cached successfully', {
                instanceId,
                expiresAt: expiresAt.toISOString(),
                expiresInSec: expiresIn,
            });
            return accessToken;
        }
        catch (err) {
            const fieldViolations = err?.response?.data?.details?.validationError?.fieldViolations ?? [];
            console.error('[WixAuth] ❌ Token request FAILED', {
                status: err?.response?.status,
                statusText: err?.response?.statusText,
                wixMessage: err?.response?.data?.message,
                fieldViolations,
                diagnosis: fieldViolations.some((v) => v.field === 'getBy.app')
                    ? '🚨 "getBy.app is invalid" = your WIX_APP_ID or WIX_APP_SECRET do not match any app in the Wix Dev Center. Check your .env against https://dev.wix.com/apps'
                    : 'Check wixDetails for the specific validation failure',
                sentBody: {
                    grant_type: requestBody.grant_type,
                    client_id: requestBody.client_id,
                    instance_id: requestBody.instance_id,
                    client_secret: `${appSecret.slice(0, 8)}...${appSecret.slice(-4)}`
                },
                requestId: err?.response?.headers?.['x-wix-request-id'],
            });
            throw err;
        }
    }
    async authHeaders(instanceId) {
        console.log('[WixAuth] 🔑 Building auth headers', { instanceId });
        const token = await this.getWixToken(instanceId);
        return {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        };
    }
    // ---------------------------------------------------------------------------
    // Contacts CRUD (Wix Contacts v4)
    // ---------------------------------------------------------------------------
    async createContact(instanceId, contactData) {
        console.log('[WixContacts] 📝 Creating contact', {
            instanceId,
            email: contactData.email,
            firstName: contactData.firstName,
            lastName: contactData.lastName,
        });
        const headers = await this.authHeaders(instanceId);
        const body = { info: this.buildWixContactInfo(contactData) };
        console.log('[WixContacts] 📤 Sending createContact payload', {
            url: this.contactsBaseURL,
            body: JSON.stringify(body, null, 2),
        });
        try {
            const response = await axios_1.default.post(this.contactsBaseURL, body, { headers });
            console.log('[WixContacts] ✅ Contact created', {
                contactId: response.data?.contact?.id,
                revision: response.data?.contact?.revision,
                status: response.status,
            });
            return this.normalizeWixContact(response.data.contact);
        }
        catch (err) {
            // Handle duplicate contact gracefully
            if (err?.response?.status === 409 &&
                err?.response?.data?.details?.applicationError?.code === 'DUPLICATE_CONTACT_EXISTS') {
                const duplicateContactId = err?.response?.data?.details?.applicationError?.data?.duplicateContactId;
                const duplicateEmail = err?.response?.data?.details?.applicationError?.data?.duplicateEmail;
                console.log('[WixContacts] ⚠️ Contact already exists, fetching existing', {
                    duplicateContactId,
                    duplicateEmail
                });
                // Fetch and return the existing contact
                return await this.getContact(instanceId, duplicateContactId);
            }
            console.error('[WixContacts] ❌ createContact FAILED', {
                status: err?.response?.status,
                statusText: err?.response?.statusText,
                wixMessage: err?.response?.data?.message,
                wixDetails: JSON.stringify(err?.response?.data?.details, null, 2),
                sentBody: JSON.stringify(body, null, 2),
                requestId: err?.response?.headers?.['x-wix-request-id'],
            });
            throw err;
        }
    }
    async updateContact(instanceId, contactId, contactData) {
        console.log('[WixContacts] ✏️ Updating contact', {
            instanceId,
            contactId,
            email: contactData.email,
            firstName: contactData.firstName,
            lastName: contactData.lastName,
        });
        const headers = await this.authHeaders(instanceId);
        // Try to get the contact - if it doesn't exist, create it instead
        let current = null;
        try {
            current = await this.getContact(instanceId, contactId);
        }
        catch (err) {
            // If contact not found (404), we'll create a new one
            if (err?.response?.status === 404) {
                console.log('[WixContacts] ℹ️ Contact not found, will create instead', { contactId });
                const created = await this.createContact(instanceId, contactData);
                console.log('[WixContacts] ✅ Contact created as replacement for update', {
                    oldId: contactId,
                    newId: created.id,
                });
                return;
            }
            // Re-throw other errors
            throw err;
        }
        const body = {
            revision: current.revision,
            info: this.buildWixContactInfo(contactData),
        };
        console.log('[WixContacts] 📤 Sending updateContact payload', {
            url: `${this.contactsBaseURL}/${contactId}`,
            revision: current.revision,
            body: JSON.stringify(body, null, 2),
        });
        try {
            const response = await axios_1.default.patch(`${this.contactsBaseURL}/${contactId}`, body, { headers });
            console.log('[WixContacts] ✅ Contact updated', {
                contactId,
                status: response.status,
            });
        }
        catch (err) {
            console.error('[WixContacts] ❌ updateContact FAILED', {
                contactId,
                status: err?.response?.status,
                statusText: err?.response?.statusText,
                wixMessage: err?.response?.data?.message,
                wixDetails: JSON.stringify(err?.response?.data?.details, null, 2),
                sentBody: JSON.stringify(body, null, 2),
                requestId: err?.response?.headers?.['x-wix-request-id'],
            });
            throw err;
        }
    }
    async getContact(instanceId, contactId) {
        console.log('[WixContacts] 🔍 Fetching contact', { instanceId, contactId });
        const headers = await this.authHeaders(instanceId);
        try {
            const response = await axios_1.default.get(`${this.contactsBaseURL}/${contactId}`, { headers });
            console.log('[WixContacts] ✅ Contact fetched', {
                contactId,
                revision: response.data?.contact?.revision,
                status: response.status,
            });
            return this.normalizeWixContact(response.data.contact);
        }
        catch (err) {
            console.error('[WixContacts] ❌ getContact FAILED', {
                contactId,
                status: err?.response?.status,
                statusText: err?.response?.statusText,
                wixMessage: err?.response?.data?.message,
                wixDetails: JSON.stringify(err?.response?.data?.details, null, 2),
                requestId: err?.response?.headers?.['x-wix-request-id'],
            });
            throw err;
        }
    }
    async getContactOrNull(instanceId, contactId) {
        console.log('[WixContacts] 🔍 Fetching contact (nullable)', { instanceId, contactId });
        const headers = await this.authHeaders(instanceId);
        try {
            const response = await axios_1.default.get(`${this.contactsBaseURL}/${contactId}`, { headers });
            console.log('[WixContacts] ✅ Contact fetched', {
                contactId,
                revision: response.data?.contact?.revision,
                status: response.status,
            });
            return this.normalizeWixContact(response.data.contact);
        }
        catch (err) {
            if (err?.response?.status === 404) {
                console.log('[WixContacts] ℹ️ Contact not found', { contactId });
                return null;
            }
            console.error('[WixContacts] ❌ getContactOrNull FAILED', {
                contactId,
                status: err?.response?.status,
                statusText: err?.response?.statusText,
                wixMessage: err?.response?.data?.message,
                requestId: err?.response?.headers?.['x-wix-request-id'],
            });
            throw err;
        }
    }
    async queryContactByEmail(instanceId, email) {
        console.log('[WixContacts] 🔍 Querying contact by email', { instanceId, email });
        const headers = await this.authHeaders(instanceId);
        const body = {
            query: {
                filter: { 'info.emails.email': { $eq: email } },
                paging: { limit: 1 },
            },
        };
        try {
            const response = await axios_1.default.post(`${this.contactsBaseURL}/query`, body, { headers });
            const contacts = response.data.contacts ?? [];
            console.log('[WixContacts] ✅ Query complete', {
                email,
                matchesFound: contacts.length,
                status: response.status,
            });
            if (contacts.length === 0)
                return null;
            return this.normalizeWixContact(contacts[0]);
        }
        catch (err) {
            console.error('[WixContacts] ❌ queryContactByEmail FAILED', {
                email,
                status: err?.response?.status,
                statusText: err?.response?.statusText,
                wixMessage: err?.response?.data?.message,
                wixDetails: JSON.stringify(err?.response?.data?.details, null, 2),
                requestId: err?.response?.headers?.['x-wix-request-id'],
            });
            throw err;
        }
    }
    async createOrUpdateContact(instanceId, email, contactData) {
        console.log('[WixContacts] 🔄 createOrUpdateContact', { instanceId, email });
        const existing = await this.queryContactByEmail(instanceId, email);
        if (existing) {
            console.log('[WixContacts] 🔁 Contact exists — updating', {
                contactId: existing.id,
                email,
            });
            await this.updateContact(instanceId, existing.id, contactData);
            return { id: existing.id, isNew: false };
        }
        console.log('[WixContacts] 🆕 Contact not found — creating', { email });
        const created = await this.createContact(instanceId, { ...contactData, email });
        return { id: created.id, isNew: true };
    }
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    buildWixContactInfo(data) {
        const info = {};
        if (data.firstName || data.lastName) {
            info.name = {};
            if (data.firstName)
                info.name.first = data.firstName;
            if (data.lastName)
                info.name.last = data.lastName;
        }
        if (data.email) {
            info.emails = {
                items: [{ tag: 'MAIN', email: data.email, primary: true }],
            };
        }
        if (data.phone) {
            info.phones = {
                items: [{ tag: 'HOME', phone: data.phone, primary: true }],
            };
        }
        if (data.company)
            info.company = data.company;
        if (data.jobTitle)
            info.jobTitle = data.jobTitle;
        console.log('[WixContacts] 🏗️ Built contact info', {
            hasName: !!info.name,
            hasEmail: !!info.emails,
            hasPhone: !!info.phones,
            hasCompany: !!info.company,
            hasJobTitle: !!info.jobTitle,
        });
        return info;
    }
    normalizeWixContact(raw) {
        const emails = raw?.info?.emails?.items ?? [];
        const phones = raw?.info?.phones?.items ?? [];
        const primaryEmail = emails.find((e) => e.primary)?.email ?? emails[0]?.email ?? undefined;
        const primaryPhone = phones.find((p) => p.primary)?.phone ?? phones[0]?.phone ?? undefined;
        const normalized = {
            id: raw.id,
            revision: raw.revision,
            firstName: raw?.info?.name?.first,
            lastName: raw?.info?.name?.last,
            email: primaryEmail,
            phone: primaryPhone,
            company: raw?.info?.company,
            jobTitle: raw?.info?.jobTitle,
            createdDate: raw.createdDate,
            updatedDate: raw.updatedDate,
            version: raw.revision ?? 0,
        };
        console.log('[WixContacts] 🔧 Normalized contact', {
            id: normalized.id,
            revision: normalized.revision,
            email: normalized.email,
            firstName: normalized.firstName,
            lastName: normalized.lastName,
        });
        return normalized;
    }
}
exports.WixService = WixService;
//# sourceMappingURL=wix.service.js.map