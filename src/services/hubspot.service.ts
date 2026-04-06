// src/services/hubspot.service.ts
import axios from 'axios';
import { prisma } from '../config/database';
import { HubSpotTokenData, HubSpotContact } from '../types';

export class HubSpotService {
  private static instance: HubSpotService;
  private baseURL = 'https://api.hubapi.com';

  static getInstance(): HubSpotService {
    if (!HubSpotService.instance) {
      HubSpotService.instance = new HubSpotService();
    }
    return HubSpotService.instance;
  }

  async getAccessToken(connectionId: string): Promise<string> {
    const connection = await prisma.hubSpotConnection.findUnique({
      where: { id: connectionId }
    });

    if (!connection) {
      throw new Error('Connection not found');
    }

    if (new Date() >= connection.expiresAt) {
      return await this.refreshAccessToken(connectionId, connection.refreshToken);
    }

    return connection.accessToken;
  }

  private async refreshAccessToken(connectionId: string, refreshToken: string): Promise<string> {
    // FIX 1: Switched from v1 to v3 OAuth endpoint, and params moved to request body
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', process.env.HUBSPOT_CLIENT_ID!);
    params.append('client_secret', process.env.HUBSPOT_CLIENT_SECRET!);
    params.append('refresh_token', refreshToken);

    const response = await axios.post(
      'https://api.hubapi.com/oauth/v3/token',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const data: HubSpotTokenData = response.data;

    await prisma.hubSpotConnection.update({
      where: { id: connectionId },
      data: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
        scope: data.scope
      }
    });

    return data.access_token;
  }

  async createContact(connectionId: string, contactData: Record<string, any>): Promise<HubSpotContact> {
    const accessToken = await this.getAccessToken(connectionId);
    
    const response = await axios.post(
      `${this.baseURL}/crm/v3/objects/contacts`,
      { properties: contactData },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    return response.data;
  }

  async updateContact(connectionId: string, contactId: string, contactData: Record<string, any>): Promise<void> {
    const accessToken = await this.getAccessToken(connectionId);
    
    await axios.patch(
      `${this.baseURL}/crm/v3/objects/contacts/${contactId}`,
      { properties: contactData },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  }

  async getContact(connectionId: string, contactId: string): Promise<HubSpotContact> {
    const accessToken = await this.getAccessToken(connectionId);
    
    const response = await axios.get(
      `${this.baseURL}/crm/v3/objects/contacts/${contactId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    return response.data;
  }

  async searchContactByEmail(connectionId: string, email: string): Promise<HubSpotContact | null> {
    const accessToken = await this.getAccessToken(connectionId);
    
    const response = await axios.post(
      `${this.baseURL}/crm/v3/objects/contacts/search`,
      {
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: 'EQ',
            value: email
          }]
        }]
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    return response.data.results?.[0] || null;
  }

  async createOrUpdateContact(connectionId: string, email: string, contactData: Record<string, any>): Promise<{ id: string; isNew: boolean }> {
    const existingContact = await this.searchContactByEmail(connectionId, email);
    
    if (existingContact) {
      await this.updateContact(connectionId, existingContact.id, contactData);
      return { id: existingContact.id, isNew: false };
    } else {
      const newContact = await this.createContact(connectionId, { ...contactData, email });
      return { id: newContact.id, isNew: true };
    }
  }

  async subscribeToWebhooks(connectionId: string, portalId: string): Promise<void> {
    // FIX 2: Webhooks API is app-level, must use the developer private app token,
    // NOT the installed user's OAuth access token.
    const developerApiKey = process.env.HUBSPOT_DEVELOPER_API_KEY;
    const appId = process.env.HUBSPOT_APP_ID;

    if (!developerApiKey) {
      console.error('❌ HUBSPOT_DEVELOPER_API_KEY not set in environment variables. Webhook subscriptions skipped.');
      return;
    }

    if (!appId) {
      console.error('❌ HUBSPOT_APP_ID not set in environment variables. Webhook subscriptions skipped.');
      return;
    }

    console.log(`📡 Setting up webhook subscriptions for portal ${portalId} with app ID ${appId}`);

    const subscriptions = [
      {
        eventType: 'contact.creation',
        active: true
      },
      {
        eventType: 'contact.propertyChange',
        propertyName: 'email',
        active: true
      },
      {
        eventType: 'contact.propertyChange',
        propertyName: 'firstname',
        active: true
      },
      {
        eventType: 'contact.propertyChange',
        propertyName: 'lastname',
        active: true
      }
    ];

    // First check if subscriptions already exist to avoid duplicates
    // NOTE: HubSpot Webhooks API ONLY accepts the Developer API key as a
    // ?hapikey= query param. Bearer token auth is NOT supported here.
    let existingSubscriptions: any[] = [];
    try {
      const existing = await axios.get(
        `${this.baseURL}/webhooks/v3/${appId}/subscriptions?hapikey=${developerApiKey}`
      );
      existingSubscriptions = existing.data?.results || existing.data || [];
      console.log(`  ℹ️  Found ${existingSubscriptions.length} existing webhook subscription(s)`);
    } catch (err: any) {
      console.warn('  ⚠️  Could not fetch existing subscriptions, proceeding anyway');
    }

    let successCount = 0;
    let skippedCount = 0;
    let failCount = 0;

    for (const subscription of subscriptions) {
      const alreadyExists = existingSubscriptions.some(
        (s: any) =>
          s.eventType === subscription.eventType &&
          (subscription as any).propertyName
            ? s.propertyName === (subscription as any).propertyName
            : true
      );

      if (alreadyExists) {
        console.log(`  ⏭️  Skipping (already exists): ${subscription.eventType}${(subscription as any).propertyName ? ` (${(subscription as any).propertyName})` : ''}`);
        skippedCount++;
        continue;
      }

      try {
        console.log(`  → Creating subscription: ${subscription.eventType}${(subscription as any).propertyName ? ` (${(subscription as any).propertyName})` : ''}`);

        await axios.post(
          `${this.baseURL}/webhooks/v3/${appId}/subscriptions?hapikey=${developerApiKey}`,
          subscription,
          { headers: { 'Content-Type': 'application/json' } }
        );

        console.log(`  ✅ Successfully created subscription: ${subscription.eventType}`);
        successCount++;
      } catch (error: any) {
        failCount++;
        console.error(`  ❌ Failed to create subscription ${subscription.eventType}:`);

        if (error.response) {
          console.error(`     Status: ${error.response.status}`);
          console.error(`     Message: ${error.response.data?.message || error.message}`);
          console.error(`     Correlation ID: ${error.response.data?.correlationId}`);
        } else {
          console.error(`     Error: ${error.message}`);
        }
      }
    }

    console.log(`📊 Webhook setup complete: ${successCount} created, ${skippedCount} skipped, ${failCount} failed`);

    if (failCount > 0) {
      console.log(`💡 Tip: Configure webhooks manually at https://app.hubspot.com/developer/148173654/apps`);
    }
  }

  async testConnection(connectionId: string): Promise<boolean> {
    try {
      const accessToken = await this.getAccessToken(connectionId);
      const response = await axios.get(
        `${this.baseURL}/crm/v3/objects/contacts?limit=1`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      return response.status === 200;
    } catch (error) {
      console.error('Connection test failed:', error);
      return false;
    }
  }

  async getWebhookSubscriptions(): Promise<any[]> {
    // FIX 2 (continued): this is also an app-level call, use developer key
    const developerApiKey = process.env.HUBSPOT_DEVELOPER_API_KEY;
    const appId = process.env.HUBSPOT_APP_ID;

    if (!developerApiKey || !appId) {
      console.error('❌ HUBSPOT_DEVELOPER_API_KEY or HUBSPOT_APP_ID not set');
      return [];
    }

    try {
      const response = await axios.get(
        `${this.baseURL}/webhooks/v3/${appId}/subscriptions?hapikey=${developerApiKey}`
      );
      return response.data?.results || response.data || [];
    } catch (error) {
      console.error('Failed to get webhook subscriptions:', error);
      return [];
    }
  }
}